import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Database } from "bun:sqlite";
import { openAndMigrate } from "../src/db.ts";
import {
  applySuccess,
  type ClosedSubIssue,
  type DivergenceState,
  getDivergenceState,
  gitOps,
  type MergeabilityView,
  type OpenManagedPr,
  reconcileOpenPRs,
  type ReconcilerGateway,
  tryMergeMainNewWorkAsBase,
  tryRebaseOntoMain,
} from "../src/reconcilers/pr-divergence.ts";

/**
 * Integration tests for the rebase / merge helpers exercised against real `git`
 * (no `gh`, no GitHub). The fixture builds a bare remote + a "main" working
 * checkout (which pushes to it) + a "feature" worktree the helper rebases.
 * Three rebase cases — clean fast-forward, non-FF without conflict, conflict +
 * abort — plus the merge-commit fallback (Phase 3, exercised in a sibling
 * describe block once the helper lands).
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "middle-test",
  GIT_AUTHOR_EMAIL: "middle-test@example.invalid",
  GIT_COMMITTER_NAME: "middle-test",
  GIT_COMMITTER_EMAIL: "middle-test@example.invalid",
};

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: GIT_ENV,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
  }
  return { stdout, stderr };
}

let scratch: string;
let remote: string; // bare repo
let work: string; // main-side working checkout (pushes to `remote`)
let worktree: string; // feature-side working checkout (the rebase target)
let db: Database; // for applySuccess persistence checks

async function writeAndCommit(
  cwd: string,
  file: string,
  content: string,
  message: string,
): Promise<string> {
  writeFileSync(join(cwd, file), content);
  await git(cwd, ["add", file]);
  await git(cwd, ["commit", "-m", message]);
  return (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
}

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "middle-pr-div-int-")));
  remote = join(scratch, "remote.git");
  work = join(scratch, "work");
  worktree = join(scratch, "worktree");

  // Bare remote: where both sides push/fetch. Pin its default branch to `main`
  // so the first push lands as `main` regardless of host git defaults.
  await git(scratch, ["init", "--bare", "--initial-branch=main", "remote.git"]);

  // Main-side checkout: seeds main, then makes future divergence by pushing
  // additional commits to `origin/main`. Init standalone (cloning an empty bare
  // repo fails when the requested ref doesn't exist yet) and wire its remote.
  await git(scratch, ["init", "--initial-branch=main", "work"]);
  await git(work, ["remote", "add", "origin", remote]);
  await writeAndCommit(work, "README.md", "init\n", "init");
  await git(work, ["push", "-u", "origin", "main"]);

  // Feature-side checkout: where the helper actually runs. Cloned from the now-
  // seeded remote; the branch is the managed `middle-issue-<N>` convention.
  await git(scratch, ["clone", "-b", "main", remote, "worktree"]);
  await git(worktree, ["checkout", "-b", "middle-issue-32"]);
  // Push the feature branch so `git fetch origin middle-issue-32` succeeds in
  // applySuccess — the remote-tracking ref needs to exist before we compare.
  await git(worktree, ["push", "-u", "origin", "middle-issue-32"]);

  db = openAndMigrate(join(scratch, "db.sqlite3"));
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Resolve the PR's worktree to the `worktree` checkout above, bypassing the
 * worktree-root math. Tests inject this stub so the helper runs against the
 * checkout we control.
 */
function deps(stub: { fetch?: typeof gitOps.fetch; rebase?: typeof gitOps.rebase } = {}) {
  return {
    github: {
      async getPrHeadRef() {
        return "middle-issue-32";
      },
    },
    git: { ...gitOps, ...stub },
    resolveRepoPath: () => work,
    // Override createWorktree so a "missing" worktree is treated as the fixture.
    createWorktree: async () => ({
      repoPath: work,
      path: worktree,
      branch: "middle-issue-32",
      repo: "o/r",
      unit: "issue-32",
    }),
    // Force the helper's resolved path TO the fixture worktree, regardless of
    // what `worktreePathFor` would compute under `~/.middle/worktrees`.
    worktreeRoot: scratch,
  };
}

/**
 * Plant the fixture worktree under the layout the helper expects
 * (`<root>/<repo>/issue-<N>/`) as a symlink to the real `worktree` checkout.
 * `existsSync` on the symlink succeeds, the helper uses it, and `git -C` on the
 * symlinked path follows through to the real fixture.
 */
async function aliasFixtureUnderRoot(repo: string, epic: number): Promise<void> {
  const target = join(scratch, repo, `issue-${epic}`);
  const parent = join(scratch, repo);
  await Bun.spawn(["mkdir", "-p", parent], { stderr: "ignore", stdout: "ignore" }).exited;
  await Bun.spawn(["ln", "-s", worktree, target], { stderr: "ignore", stdout: "ignore" }).exited;
}

describe("tryRebaseOntoMain — fixture repo", () => {
  test("clean fast-forward: feature has no commits past old main; main advanced → rebase FFs", async () => {
    // Main advances by one commit; feature is still at the seed.
    await writeAndCommit(work, "main-file.txt", "main only\n", "main: add file");
    await git(work, ["push", "origin", "main"]);

    await aliasFixtureUnderRoot("o/r", 32);
    const result = await tryRebaseOntoMain(deps(), "o/r", 999);
    expect(result).toEqual({ ok: true });

    // Feature now contains main's new file (fast-forwarded).
    expect(existsSync(join(worktree, "main-file.txt"))).toBe(true);
  });

  test("non-FF, no conflict: feature edits A, main edits B, no shared paths → rebase replays cleanly", async () => {
    // Feature edits its own file.
    await writeAndCommit(worktree, "feature.txt", "feature\n", "feature: add");
    const featureSha = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();

    // Main advances on a disjoint path.
    await writeAndCommit(work, "main.txt", "main\n", "main: add");
    await git(work, ["push", "origin", "main"]);

    await aliasFixtureUnderRoot("o/r", 32);
    const result = await tryRebaseOntoMain(deps(), "o/r", 999);
    expect(result).toEqual({ ok: true });

    // Both files exist; HEAD has moved (rebase replayed feature on top of main).
    expect(existsSync(join(worktree, "feature.txt"))).toBe(true);
    expect(existsSync(join(worktree, "main.txt"))).toBe(true);
    const newSha = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
    expect(newSha).not.toBe(featureSha);
  });

  test("conflict: feature + main both edit shared.txt → rebase aborts, paths reported, worktree clean", async () => {
    // Seed a shared file on main first.
    await writeAndCommit(work, "shared.txt", "line\n", "main: seed shared");
    await git(work, ["push", "origin", "main"]);
    // Reset the feature worktree to that seed so both sides start from the same point.
    await git(worktree, ["fetch", "origin", "main"]);
    await git(worktree, ["reset", "--hard", "origin/main"]);
    await git(worktree, ["checkout", "-B", "middle-issue-32"]);

    // Feature edits the shared line.
    await writeAndCommit(worktree, "shared.txt", "feature edit\n", "feature: edit shared");
    const featureSha = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();

    // Main edits the SAME line.
    await writeAndCommit(work, "shared.txt", "main edit\n", "main: edit shared");
    await git(work, ["push", "origin", "main"]);

    await aliasFixtureUnderRoot("o/r", 32);
    const result = await tryRebaseOntoMain(deps(), "o/r", 999);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflictingPaths).toEqual(["shared.txt"]);

    // Worktree is clean after abort: HEAD back at feature, no rebase state.
    expect((await git(worktree, ["rev-parse", "HEAD"])).stdout.trim()).toBe(featureSha);
    expect(existsSync(join(worktree, ".git", "rebase-merge"))).toBe(false);
    expect(existsSync(join(worktree, ".git", "rebase-apply"))).toBe(false);
  });

  test("a non-managed head ref (not middle-issue-*) → ok:false with empty paths (skip signal)", async () => {
    const skipDeps = {
      ...deps(),
      github: {
        async getPrHeadRef() {
          return "feature/random";
        },
      },
    };
    const result = await tryRebaseOntoMain(skipDeps, "o/r", 999);
    expect(result).toEqual({ ok: false, conflictingPaths: [] });
  });

  test("a missing PR (gateway returns null) → ok:false with empty paths (skip signal)", async () => {
    const skipDeps = {
      ...deps(),
      github: {
        async getPrHeadRef() {
          return null;
        },
      },
    };
    const result = await tryRebaseOntoMain(skipDeps, "o/r", 999);
    expect(result).toEqual({ ok: false, conflictingPaths: [] });
  });
});

describe("tryMergeMainNewWorkAsBase — fixture repo", () => {
  test("rebase would loop but merge -X ours lands cleanly (same line, feature wins)", async () => {
    // Seed shared file on main first, reset feature so both start from one commit.
    await writeAndCommit(work, "shared.txt", "line\n", "main: seed shared");
    await git(work, ["push", "origin", "main"]);
    await git(worktree, ["fetch", "origin", "main"]);
    await git(worktree, ["reset", "--hard", "origin/main"]);
    await git(worktree, ["checkout", "-B", "middle-issue-32"]);

    // Same line, both sides. Rebase would conflict; merge -X ours auto-resolves.
    await writeAndCommit(worktree, "shared.txt", "feature edit\n", "feature: edit shared");
    await writeAndCommit(work, "shared.txt", "main edit\n", "main: edit shared");
    await git(work, ["push", "origin", "main"]);

    await aliasFixtureUnderRoot("o/r", 32);

    // Sanity: rebase fails first (we exercised this in the rebase suite).
    const rebaseResult = await tryRebaseOntoMain(deps(), "o/r", 999);
    expect(rebaseResult.ok).toBe(false);

    // The fallback lands; feature's content wins (-X ours preserves the branch).
    const mergeResult = await tryMergeMainNewWorkAsBase(deps(), "o/r", 999);
    expect(mergeResult).toEqual({ ok: true });

    const contents = await Bun.file(join(worktree, "shared.txt")).text();
    expect(contents).toBe("feature edit\n");

    // A merge commit landed (not a fast-forward) — the reconciliation is visible
    // in history so a reviewer can see main was folded in.
    const parents = (await git(worktree, ["rev-list", "--parents", "-n", "1", "HEAD"])).stdout
      .trim()
      .split(/\s+/);
    expect(parents.length).toBeGreaterThanOrEqual(3); // child + ≥2 parents
  });

  // applySuccess integration tests live alongside the git helpers so they
  // share the fixture; declared here so the shared describe block stays one
  // unit. (See the `applySuccess` describe block below.)
  test("residual conflict -X ours can't auto-resolve (rename/rename) → abort, paths reported", async () => {
    // Seed a baseline file, reset feature to it.
    await writeAndCommit(work, "shared.txt", "baseline\n", "main: seed shared");
    await git(work, ["push", "origin", "main"]);
    await git(worktree, ["fetch", "origin", "main"]);
    await git(worktree, ["reset", "--hard", "origin/main"]);
    await git(worktree, ["checkout", "-B", "middle-issue-32"]);

    // Feature renames shared.txt → feature-name.txt
    await git(worktree, ["mv", "shared.txt", "feature-name.txt"]);
    await git(worktree, ["commit", "-m", "feature: rename"]);
    const featureSha = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();

    // Main renames shared.txt → main-name.txt — rename/rename is a structural
    // conflict that -X ours cannot resolve.
    await git(work, ["mv", "shared.txt", "main-name.txt"]);
    await git(work, ["commit", "-m", "main: rename"]);
    await git(work, ["push", "origin", "main"]);

    await aliasFixtureUnderRoot("o/r", 32);
    const result = await tryMergeMainNewWorkAsBase(deps(), "o/r", 999);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The unmerged paths are whatever git's rename/rename resolver records;
      // assert it surfaces at least one of the two renamed targets, so a real
      // bug surfaces (an unconditionally-empty paths list).
      expect(result.conflictingPaths.length).toBeGreaterThan(0);
    }

    // Worktree clean after abort: HEAD back at feature, no leftover MERGE_HEAD.
    expect((await git(worktree, ["rev-parse", "HEAD"])).stdout.trim()).toBe(featureSha);
    expect(existsSync(join(worktree, ".git", "MERGE_HEAD"))).toBe(false);
  });
});

describe("applySuccess — fixture repo", () => {
  /**
   * Spy on PR-comment listing + posting. Mirrors the existing
   * `GitHubGateway` subset {@link applySuccess} consumes.
   */
  function makeCommentSpy(): {
    listIssueComments: (repo: string, prNumber: number) => Promise<{ body: string }[]>;
    postComment: (repo: string, prNumber: number, body: string) => Promise<void>;
    posted: string[];
  } {
    const posted: string[] = [];
    return {
      posted,
      async listIssueComments() {
        return posted.map((body) => ({ body }));
      },
      async postComment(_repo, _prNumber, body) {
        posted.push(body);
      },
    };
  }

  test("pushes the rebased branch, posts one PR comment, and records CLEAN — twice = idempotent", async () => {
    // Make the feature branch ahead of origin/middle-issue-32: do a rebase
    // first (simulating Phase 2 having run) so the local branch differs from
    // its already-pushed remote.
    await writeAndCommit(work, "main-file.txt", "main only\n", "main: add file");
    await git(work, ["push", "origin", "main"]);
    await aliasFixtureUnderRoot("o/r", 32);

    const rebaseResult = await tryRebaseOntoMain(deps(), "o/r", 999);
    expect(rebaseResult).toEqual({ ok: true });

    const comments = makeCommentSpy();
    const baseDeps = deps();
    const successDeps = {
      ...baseDeps,
      db,
      github: { ...baseDeps.github, ...comments },
      now: () => 1_700_000_000_000,
    };

    // First invocation: pushes (local was ahead) and posts the announcement.
    await applySuccess(successDeps, "o/r", 999, "rebased", "abcdef1234567890");

    expect(comments.posted.length).toBe(1);
    expect(comments.posted[0]).toContain("🔁 Reconciled with main (rebased) after abcdef123");
    expect(comments.posted[0]).toContain("<!-- middle-divergence: abcdef123:rebased -->");
    expect(getDivergenceState(db, "o/r", 999)).toEqual({
      state: "CLEAN",
      classifiedAt: 1_700_000_000_000,
    });

    // The branch landed on origin (force-with-lease push succeeded — the bare
    // remote now has the rebased HEAD).
    const localSha = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
    const remoteSha = (await git(remote, ["rev-parse", "middle-issue-32"])).stdout.trim();
    expect(remoteSha).toBe(localSha);

    // Second invocation for the same reconciliation: no double-comment, no
    // error. The state row's classified_at re-stamps (upsert) so the row stays
    // fresh; that's expected, not a duplication issue.
    await applySuccess(
      { ...successDeps, now: () => 1_700_000_001_000 },
      "o/r",
      999,
      "rebased",
      "abcdef1234567890",
    );
    expect(comments.posted.length).toBe(1);
    expect(getDivergenceState(db, "o/r", 999)?.classifiedAt).toBe(1_700_000_001_000);
  });

  test("a different mainCommitSha allows a fresh announcement (the marker is sha-keyed)", async () => {
    // Feature is already in sync; no push needed. But a *new* reconciliation
    // against a different main sha is a different event and should re-announce.
    await aliasFixtureUnderRoot("o/r", 32);
    const comments = makeCommentSpy();
    const baseDeps = deps();
    const successDeps = {
      ...baseDeps,
      db,
      github: { ...baseDeps.github, ...comments },
      now: () => 100,
    };

    await applySuccess(successDeps, "o/r", 999, "merged-new-work-as-base", "aaaaaaaaa11111");
    await applySuccess(successDeps, "o/r", 999, "merged-new-work-as-base", "aaaaaaaaa11111");
    expect(comments.posted.length).toBe(1); // same sha → skipped

    await applySuccess(successDeps, "o/r", 999, "merged-new-work-as-base", "bbbbbbbbb22222");
    expect(comments.posted.length).toBe(2); // new sha → re-announced
    expect(comments.posted[1]).toContain("merged-new-work-as-base");
    expect(comments.posted[1]).toContain("bbbbbbbbb");
  });

  test("a non-managed head ref is a no-op (no push, no comment, no row)", async () => {
    const comments = makeCommentSpy();
    const baseDeps = deps();
    const successDeps = {
      ...baseDeps,
      db,
      github: {
        ...baseDeps.github,
        ...comments,
        async getPrHeadRef() {
          return "feature/random";
        },
      },
      now: () => 100,
    };
    await applySuccess(successDeps, "o/r", 999, "rebased", "deadbeef00000");
    expect(comments.posted).toEqual([]);
    expect(getDivergenceState(db, "o/r", 999)).toBe(null);
  });
});

describe("reconcileOpenPRs — end-to-end against the fixture repo", () => {
  /**
   * Build a fully-stubbed `ReconcilerGateway` keyed by PR number for the
   * orchestrator's read paths, and recording counters for its write paths.
   * Comments + open PR list + closed sub-issues are driven by the per-test
   * setup; the git operations (rebase / merge / push) run against the real
   * fixture worktree.
   */
  function makeOrchestratorGateway(opts: {
    openPrs: OpenManagedPr[];
    mergeability: Record<number, MergeabilityView | null>;
    headRefs: Record<number, string | null>;
    closedSubIssues?: ClosedSubIssue[];
    mainSha?: string;
  }) {
    const calls = {
      listOpenManagedPrs: 0,
      getMainCommitSha: 0,
      getMergeability: 0 as number,
      getPrHeadRef: 0 as number,
      postComment: [] as { issueNumber: number; body: string }[],
      convertPrToDraft: [] as number[],
      reopenIssue: [] as { issueNumber: number; comment: string | undefined }[],
    };
    const comments = new Map<number, string[]>();
    const drafts = new Set<number>();
    const gateway: ReconcilerGateway = {
      async listOpenManagedPrs() {
        calls.listOpenManagedPrs++;
        return opts.openPrs;
      },
      async getMainCommitSha() {
        calls.getMainCommitSha++;
        return opts.mainSha ?? "main-sha-123";
      },
      async getMergeability(_repo, prNumber) {
        calls.getMergeability++;
        return opts.mergeability[prNumber] ?? null;
      },
      async getPrHeadRef(_repo, prNumber) {
        calls.getPrHeadRef++;
        return opts.headRefs[prNumber] ?? null;
      },
      async getPullRequest(_repo, prNumber) {
        return { isDraft: drafts.has(prNumber) };
      },
      async convertPrToDraft(_repo, prNumber) {
        calls.convertPrToDraft.push(prNumber);
        drafts.add(prNumber);
      },
      async listClosedSubIssues() {
        return opts.closedSubIssues ?? [];
      },
      async reopenIssue(_repo, issueNumber, options) {
        calls.reopenIssue.push({ issueNumber, comment: options?.comment });
      },
      async listIssueComments(_repo, issueNumber) {
        return (comments.get(issueNumber) ?? []).map((body) => ({ body }));
      },
      async postComment(_repo, issueNumber, body) {
        calls.postComment.push({ issueNumber, body });
        const bucket = comments.get(issueNumber) ?? [];
        bucket.push(body);
        comments.set(issueNumber, bucket);
      },
    };
    return { gateway, calls, comments, drafts };
  }

  test("BEHIND PR rebases cleanly on the next tick, applies success, and a re-tick is idempotent", async () => {
    // Set up the fixture: main advances by one disjoint commit so the feature
    // branch is BEHIND but conflict-free (the rebase helper's clean path).
    await writeAndCommit(work, "main.txt", "main\n", "main: add file");
    await git(work, ["push", "origin", "main"]);
    await aliasFixtureUnderRoot("o/r", 32);

    const fixture = makeOrchestratorGateway({
      openPrs: [{ prNumber: 100, headRefName: "middle-issue-32" }],
      headRefs: { 100: "middle-issue-32" },
      mergeability: {
        // First tick sees BEHIND; second tick sees CLEAN (the rebase landed).
        100: { mergeStateStatus: "BEHIND", mergeable: "MERGEABLE" },
      },
    });

    const baseDeps = deps();
    const enqueues: Array<[string, number]> = [];
    const orchDeps = {
      ...baseDeps,
      db,
      github: fixture.gateway,
      enqueueEpic: async (r: string, e: number) => {
        enqueues.push([r, e]);
      },
      getRateLimit: async () => ({ remaining: 5000, resetAt: 0 }),
      now: () => 1_700_000_000_000,
    };

    const r1 = await reconcileOpenPRs(orchDeps, "o/r");
    expect(r1).toEqual({ reconciled: 1, passed: 0, skippedForBudget: false });
    // The rebase moved feature on top of main; applySuccess pushed and posted.
    expect(fixture.calls.postComment.length).toBe(1);
    expect(fixture.calls.postComment[0]?.issueNumber).toBe(100);
    expect(fixture.calls.postComment[0]?.body).toContain("(rebased)");
    expect(getDivergenceState(db, "o/r", 100)?.state).toBe("CLEAN");

    // Second tick: simulate GitHub now reporting CLEAN (the push landed there).
    // The orchestrator classifies CLEAN → passed, no further side effects.
    fixture.calls.postComment = []; // reset to verify no new posts
    const orchDeps2 = {
      ...orchDeps,
      github: {
        ...fixture.gateway,
        async getMergeability() {
          return { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" } as MergeabilityView;
        },
      },
    };
    const r2 = await reconcileOpenPRs(orchDeps2, "o/r");
    expect(r2).toEqual({ reconciled: 0, passed: 1, skippedForBudget: false });
    expect(fixture.calls.postComment).toEqual([]);
    expect(fixture.calls.convertPrToDraft).toEqual([]);
    expect(enqueues).toEqual([]);
  });

  test("CONFLICTED PR rebase-fails → merge fallback lands → applySuccess('merged-new-work-as-base')", async () => {
    // Same-line edits on both sides — rebase will conflict, -X ours will resolve.
    await writeAndCommit(work, "shared.txt", "line\n", "main: seed shared");
    await git(work, ["push", "origin", "main"]);
    await git(worktree, ["fetch", "origin", "main"]);
    await git(worktree, ["reset", "--hard", "origin/main"]);
    await git(worktree, ["checkout", "-B", "middle-issue-32"]);
    await git(worktree, ["push", "-f", "origin", "middle-issue-32"]);

    await writeAndCommit(worktree, "shared.txt", "feature edit\n", "feature: edit shared");
    await writeAndCommit(work, "shared.txt", "main edit\n", "main: edit shared");
    await git(work, ["push", "origin", "main"]);

    await aliasFixtureUnderRoot("o/r", 32);

    const fixture = makeOrchestratorGateway({
      openPrs: [{ prNumber: 101, headRefName: "middle-issue-32" }],
      headRefs: { 101: "middle-issue-32" },
      mergeability: {
        101: { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" },
      },
    });

    const baseDeps = deps();
    const r = await reconcileOpenPRs(
      {
        ...baseDeps,
        db,
        github: fixture.gateway,
        enqueueEpic: async () => {},
        getRateLimit: async () => ({ remaining: 5000, resetAt: 0 }),
      },
      "o/r",
    );
    expect(r.reconciled).toBe(1);
    expect(fixture.calls.postComment.length).toBe(1);
    expect(fixture.calls.postComment[0]?.body).toContain("(merged-new-work-as-base)");
  });

  test("CONFLICTED PR both attempts fail (rename/rename) → applyDemoteToWork fires", async () => {
    // Rename/rename: -X ours can't resolve.
    await writeAndCommit(work, "shared.txt", "baseline\n", "main: seed shared");
    await git(work, ["push", "origin", "main"]);
    await git(worktree, ["fetch", "origin", "main"]);
    await git(worktree, ["reset", "--hard", "origin/main"]);
    await git(worktree, ["checkout", "-B", "middle-issue-32"]);
    await git(worktree, ["push", "-f", "origin", "middle-issue-32"]);

    await git(worktree, ["mv", "shared.txt", "feature-name.txt"]);
    await git(worktree, ["commit", "-m", "feature: rename"]);
    await git(work, ["mv", "shared.txt", "main-name.txt"]);
    await git(work, ["commit", "-m", "main: rename"]);
    await git(work, ["push", "origin", "main"]);

    await aliasFixtureUnderRoot("o/r", 32);

    const fixture = makeOrchestratorGateway({
      openPrs: [{ prNumber: 102, headRefName: "middle-issue-32" }],
      headRefs: { 102: "middle-issue-32" },
      mergeability: {
        102: { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" },
      },
      closedSubIssues: [{ number: 50, closedAt: 1_700_000_000_000 }],
    });

    const baseDeps = deps();
    const enqueues: Array<[string, number]> = [];
    const r = await reconcileOpenPRs(
      {
        ...baseDeps,
        db,
        github: fixture.gateway,
        enqueueEpic: async (repo, epicNumber) => {
          enqueues.push([repo, epicNumber]);
        },
        getRateLimit: async () => ({ remaining: 5000, resetAt: 0 }),
      },
      "o/r",
    );
    expect(r.reconciled).toBe(1);

    // Demote landed: draft conversion + sub-issue reopen + dual-surface comments + enqueue.
    expect(fixture.calls.convertPrToDraft).toEqual([102]);
    expect(fixture.calls.reopenIssue.length).toBe(1);
    expect(fixture.calls.reopenIssue[0]?.issueNumber).toBe(50);
    expect(new Set(fixture.calls.postComment.map((c) => c.issueNumber))).toEqual(
      new Set([102, 32]),
    );
    for (const c of fixture.calls.postComment) {
      expect(c.body).toContain("<!-- middle-divergence-demoted: 32 -->");
    }
    expect(enqueues).toEqual([["o/r", 32]]);
    expect(getDivergenceState(db, "o/r", 102)?.state).toBe("DEMOTED");
  });

  test("rate-limit floor short-circuits the pass; no listing happens", async () => {
    const fixture = makeOrchestratorGateway({
      openPrs: [],
      headRefs: {},
      mergeability: {},
    });
    const baseDeps = deps();
    const r = await reconcileOpenPRs(
      {
        ...baseDeps,
        db,
        github: fixture.gateway,
        enqueueEpic: async () => {},
        getRateLimit: async () => ({ remaining: 10, resetAt: Date.now() + 60_000 }),
        rateLimitBuffer: 100,
      },
      "o/r",
    );
    expect(r).toEqual({ reconciled: 0, passed: 0, skippedForBudget: true });
    expect(fixture.calls.listOpenManagedPrs).toBe(0);
  });

  test("CLEAN PR → walked but unchanged; nothing posted, no state advance", async () => {
    const fixture = makeOrchestratorGateway({
      openPrs: [{ prNumber: 103, headRefName: "middle-issue-32" }],
      headRefs: { 103: "middle-issue-32" },
      mergeability: { 103: { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" } },
    });
    const baseDeps = deps();
    const r = await reconcileOpenPRs(
      {
        ...baseDeps,
        db,
        github: fixture.gateway,
        enqueueEpic: async () => {},
        getRateLimit: async () => ({ remaining: 5000, resetAt: 0 }),
      },
      "o/r",
    );
    expect(r).toEqual({ reconciled: 0, passed: 1, skippedForBudget: false });
    expect(fixture.calls.postComment).toEqual([]);
    // Classifier still wrote a row (the recording invariant from Phase 1).
    expect(getDivergenceState(db, "o/r", 103)?.state).toBe("CLEAN" satisfies DivergenceState);
  });

  test("listOpenManagedPrs throws → pass returns 0s and logs, no orchestration", async () => {
    const fixture = makeOrchestratorGateway({
      openPrs: [],
      headRefs: {},
      mergeability: {},
    });
    fixture.gateway.listOpenManagedPrs = async () => {
      throw new Error("transient gh outage");
    };
    const baseDeps = deps();
    const r = await reconcileOpenPRs(
      {
        ...baseDeps,
        db,
        github: fixture.gateway,
        enqueueEpic: async () => {},
        getRateLimit: async () => ({ remaining: 5000, resetAt: 0 }),
      },
      "o/r",
    );
    expect(r).toEqual({ reconciled: 0, passed: 0, skippedForBudget: false });
  });
});
