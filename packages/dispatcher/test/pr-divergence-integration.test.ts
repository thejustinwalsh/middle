import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Database } from "bun:sqlite";
import { openAndMigrate } from "../src/db.ts";
import {
  applySuccess,
  getDivergenceState,
  gitOps,
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
