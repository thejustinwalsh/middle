import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The persist half of the docs harvester: take the markdown the agent authored
 * into its worktree (write mode) and turn it into a reviewable change — commit
 * it locally, push the branch, and open a **draft** PR (a human merges, per the
 * spec). Read-only/audit runs never reach here; the workflow gates this on
 * `config.write`.
 *
 * Decomposed so the local commit path is exercisable by a real test against a
 * fixture repo, while the genuinely-external step (push + open PR against a live
 * GitHub remote) is an injected seam a test can stub.
 */

/** What a commit captured: the new commit's sha and the repo-relative paths it touched. */
export type CommitResult = {
  /** The new commit's full sha. */
  sha: string;
  /** Repo-relative paths the commit added/changed (POSIX separators), sorted. */
  files: string[];
};

/** The per-run inputs both the commit and the push/PR steps need. */
export type DocsPersistInput = {
  /** `owner/name` — the repo whose docs were authored. */
  repo: string;
  /** Absolute path of the docs worktree the agent wrote into. */
  worktreePath: string;
  /** The branch checked out in that worktree — the head the PR is opened from. */
  branch: string;
};

/** The injected external step: push the branch and open the draft PR. */
export type DocsPushSeam = (opts: DocsPersistInput & { commit: CommitResult }) => Promise<void>;

/** The seam the documentation workflow invokes when `config.write` is true. */
export type PersistDocs = (opts: DocsPersistInput) => Promise<void>;

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exitCode: await proc.exited };
}

/** Default commit subject for an authored/maintained docs surface. */
function defaultMessage(repo: string): string {
  return `docs: update documentation surface for ${repo}`;
}

/**
 * Stage everything the agent wrote and commit it. Returns `null` when the
 * worktree is clean — an audit-in-write-clothing that authored nothing must not
 * produce an empty commit or PR. Uses the repo's configured git identity (no
 * author overrides), per the repo convention.
 *
 * middle's own `.middle/` scratch (the prompt + hook scripts the runner drops into
 * the worktree) is excluded explicitly — not left to the target repo's `.gitignore`,
 * which may not list it — so it can never leak into a docs PR.
 */
export async function commitDocs(opts: {
  repo: string;
  worktreePath: string;
  message?: string;
}): Promise<CommitResult | null> {
  const { worktreePath } = opts;
  const add = await runGit(worktreePath, ["add", "-A"]);
  if (add.exitCode !== 0) {
    throw new Error(`docs persist: git add failed: ${add.stderr.trim()}`);
  }
  // Unstage middle's operational scratch regardless of the target repo's
  // .gitignore (which may not list it). A no-op when nothing under .middle/ was
  // staged. Done as a post-add reset rather than an `:(exclude)` add-pathspec
  // because that pathspec makes `git add` error when .middle/ *is* gitignored.
  const unstage = await runGit(worktreePath, ["reset", "-q", "--", ".middle"]);
  if (unstage.exitCode !== 0) {
    throw new Error(`docs persist: git reset .middle failed: ${unstage.stderr.trim()}`);
  }

  // Nothing staged → the agent authored no change. Skip the commit entirely.
  const staged = await runGit(worktreePath, ["diff", "--cached", "--name-only"]);
  if (staged.exitCode !== 0) {
    throw new Error(`docs persist: git diff --cached failed: ${staged.stderr.trim()}`);
  }
  const files = staged.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .sort();
  if (files.length === 0) return null;

  const message = opts.message ?? defaultMessage(opts.repo);
  const commit = await runGit(worktreePath, ["commit", "-m", message]);
  if (commit.exitCode !== 0) {
    throw new Error(`docs persist: git commit failed: ${commit.stderr.trim()}`);
  }
  const rev = await runGit(worktreePath, ["rev-parse", "HEAD"]);
  if (rev.exitCode !== 0) {
    throw new Error(`docs persist: git rev-parse HEAD failed: ${rev.stderr.trim()}`);
  }
  return { sha: rev.stdout.trim(), files };
}

async function run(argv: string[], cwd?: string): Promise<{ stderr: string; exitCode: number }> {
  const proc = Bun.spawn(argv, { cwd, stdout: "ignore", stderr: "pipe", stdin: "ignore" });
  const stderr = await new Response(proc.stderr).text();
  return { stderr, exitCode: await proc.exited };
}

/**
 * The production push/PR step: push the worktree's branch to `origin` and open a
 * **draft** PR for the authored docs. Force-with-lease is deliberately NOT used —
 * the docs branch is the bot's own and a plain push is expected to fast-forward;
 * a rejected push surfaces rather than clobbering. The PR is left draft so a human
 * does the final review and merge (auto-merge is out of scope per the spec).
 */
export const ghPushAndOpenPr: DocsPushSeam = async ({ repo, worktreePath, branch, commit }) => {
  const push = await run(["git", "-C", worktreePath, "push", "-u", "origin", branch]);
  if (push.exitCode !== 0) {
    throw new Error(`docs persist: git push ${branch} failed: ${push.stderr.trim()}`);
  }

  const title = `docs: update documentation surface`;
  const bodyFile = join(tmpdir(), `middle-docs-pr-${Date.now()}.md`);
  const body = [
    `Automated docs harvester run for \`${repo}\`.`,
    "",
    `Authored/maintained the documentation surface in commit ${commit.sha}.`,
    "",
    "Files:",
    ...commit.files.map((f) => `- \`${f}\``),
    "",
    "Draft for human review — middle does not auto-merge docs PRs.",
  ].join("\n");
  await writeFile(bodyFile, body);
  try {
    const pr = await run(
      [
        "gh",
        "pr",
        "create",
        "--repo",
        repo,
        "--draft",
        "--head",
        branch,
        "--title",
        title,
        "--body-file",
        bodyFile,
      ],
      worktreePath,
    );
    // A PR may already exist for this branch from a prior run — that's not a
    // failure; the push above updated it. Only an unexpected error surfaces.
    if (pr.exitCode !== 0 && !/already exists/i.test(pr.stderr)) {
      throw new Error(`docs persist: gh pr create failed: ${pr.stderr.trim()}`);
    }
  } finally {
    await rm(bodyFile, { force: true });
  }
};

/**
 * Compose the persist seam the documentation workflow invokes: commit the
 * authored docs, then (only if something was committed) push + open the draft PR.
 * `push` defaults to the `gh`-backed production step; tests inject a stub to
 * exercise the real commit path without touching a live remote.
 */
export function makeGhPersistDocs(push: DocsPushSeam = ghPushAndOpenPr): PersistDocs {
  return async ({ repo, worktreePath, branch }) => {
    const commit = await commitDocs({ repo, worktreePath });
    if (!commit) return; // clean worktree — nothing authored, nothing to persist
    await push({ repo, worktreePath, branch, commit });
  };
}
