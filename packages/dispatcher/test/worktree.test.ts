import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktree,
  destroyWorktree,
  listWorktrees,
  pruneWorktreeAt,
  WorktreeError,
} from "../src/worktree.ts";

let scratch: string;
let repoPath: string;
let worktreeRoot: string;

// Deterministic identity for the throwaway fixture repo via env (not `-c`),
// so `git commit` doesn't depend on host-level git config.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "middle-test",
  GIT_AUTHOR_EMAIL: "middle-test@example.invalid",
  GIT_COMMITTER_NAME: "middle-test",
  GIT_COMMITTER_EMAIL: "middle-test@example.invalid",
};

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "ignore",
    stderr: "pipe",
    env: GIT_ENV,
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

/** Run git and return trimmed stdout (for reading SHAs / refs in assertions). */
async function gitOut(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: GIT_ENV,
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
  return out.trim();
}

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "middle-wt-")));
  repoPath = join(scratch, "repo");
  worktreeRoot = join(scratch, "worktrees");
  await git(scratch, ["init", "repo"]);
  // a worktree needs a HEAD to branch from; rely on the machine's git identity
  await git(repoPath, ["commit", "--allow-empty", "-m", "init"]);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("createWorktree → listWorktrees → destroyWorktree", () => {
  test("create places the worktree under <root>/<repo>/issue-<n> on a fresh branch", async () => {
    const handle = await createWorktree({
      repoPath,
      repo: "thejustinwalsh/middle",
      epicRef: "6",
      worktreeRoot,
    });
    expect(handle.path).toBe(join(worktreeRoot, "thejustinwalsh/middle", "issue-6"));
    expect(handle.branch).toBe("middle-issue-6");
    expect(handle.unit).toBe("issue-6");
    expect(existsSync(handle.path)).toBe(true);
  });

  test("the recommender unit is named 'recommender'", async () => {
    const handle = await createWorktree({
      repoPath,
      repo: "thejustinwalsh/middle",
      worktreeRoot,
    });
    expect(handle.unit).toBe("recommender");
    expect(handle.path).toBe(join(worktreeRoot, "thejustinwalsh/middle", "recommender"));
  });

  test("list enumerates active worktrees under the root", async () => {
    await createWorktree({ repoPath, repo: "o/r", epicRef: "6", worktreeRoot });
    await createWorktree({ repoPath, repo: "o/r", epicRef: "7", worktreeRoot });
    const listed = await listWorktrees({ repoPath, worktreeRoot });
    expect(listed.map((w) => w.unit).sort()).toEqual(["issue-6", "issue-7"]);
    expect(listed.every((w) => w.repo === "o/r")).toBe(true);
  });

  test("destroy removes the worktree directory and its branch", async () => {
    const handle = await createWorktree({ repoPath, repo: "o/r", epicRef: "6", worktreeRoot });
    await destroyWorktree(handle);
    expect(existsSync(handle.path)).toBe(false);
    expect(await listWorktrees({ repoPath, worktreeRoot })).toEqual([]);
    const branchCheck = Bun.spawn(
      ["git", "-C", repoPath, "rev-parse", "--verify", `refs/heads/${handle.branch}`],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await branchCheck.exited).not.toBe(0);
  });
});

describe("idempotency", () => {
  test("creating an already-existing worktree returns the handle without throwing", async () => {
    const first = await createWorktree({ repoPath, repo: "o/r", epicRef: "6", worktreeRoot });
    const second = await createWorktree({ repoPath, repo: "o/r", epicRef: "6", worktreeRoot });
    expect(second).toEqual(first);
  });

  test("destroying an already-removed worktree is a no-op, not a throw", async () => {
    const handle = await createWorktree({ repoPath, repo: "o/r", epicRef: "6", worktreeRoot });
    await destroyWorktree(handle);
    await destroyWorktree(handle); // must not throw
    expect(existsSync(handle.path)).toBe(false);
  });
});

describe("branch reuse (issue #179)", () => {
  test("reuses an existing branch — does not pass -b, so it doesn't error", async () => {
    // Branch ref survives a prune/compensation that removed only the worktree.
    await git(repoPath, ["branch", "middle-issue-9"]);
    const handle = await createWorktree({
      repoPath,
      repo: "o/r",
      epicRef: "9",
      worktreeRoot,
    });
    expect(handle.branch).toBe("middle-issue-9");
    expect(existsSync(handle.path)).toBe(true);
    // The worktree is checked out on the *reused* branch.
    expect(await gitOut(handle.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("middle-issue-9");
  });

  test("reuse checks out the existing branch's own tip, not a fresh branch from HEAD", async () => {
    // Pin the existing branch to the first commit, then move the default branch
    // ahead. A `-b` create would branch from the current HEAD (the new tip);
    // reuse must check out the branch's own (older) tip.
    const firstSha = await gitOut(repoPath, ["rev-parse", "HEAD"]);
    await git(repoPath, ["branch", "middle-issue-9", firstSha]);
    await git(repoPath, ["commit", "--allow-empty", "-m", "second"]);
    const headSha = await gitOut(repoPath, ["rev-parse", "HEAD"]);
    expect(headSha).not.toBe(firstSha);

    const handle = await createWorktree({ repoPath, repo: "o/r", epicRef: "9", worktreeRoot });
    expect(await gitOut(handle.path, ["rev-parse", "HEAD"])).toBe(firstSha);
  });

  test("still creates a fresh branch when none exists (first dispatch unchanged)", async () => {
    const branchCheck = Bun.spawn(
      ["git", "-C", repoPath, "rev-parse", "--verify", "refs/heads/middle-issue-9"],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await branchCheck.exited).not.toBe(0); // precondition: no such branch

    const handle = await createWorktree({ repoPath, repo: "o/r", epicRef: "9", worktreeRoot });
    expect(handle.branch).toBe("middle-issue-9");
    expect(
      await gitOut(repoPath, ["rev-parse", "--verify", "refs/heads/middle-issue-9"]),
    ).toBeTruthy();
  });

  test("dispatch → prune (branch survives) → re-dispatch all succeed", async () => {
    // pruneWorktreeAt deliberately leaves the local branch (the reconciler path),
    // so the second createWorktree must reuse it rather than re-creating with -b.
    const first = await createWorktree({ repoPath, repo: "o/r", epicRef: "9", worktreeRoot });
    await pruneWorktreeAt(repoPath, first.path);
    expect(existsSync(first.path)).toBe(false);
    // Branch still exists after the prune.
    expect(
      await gitOut(repoPath, ["rev-parse", "--verify", "refs/heads/middle-issue-9"]),
    ).toBeTruthy();

    const second = await createWorktree({ repoPath, repo: "o/r", epicRef: "9", worktreeRoot });
    expect(second).toEqual(first);
    expect(existsSync(second.path)).toBe(true);
  });
});

describe("failure surfacing", () => {
  test("create against a non-git directory throws WorktreeError", async () => {
    await expect(
      createWorktree({ repoPath: scratch, repo: "o/r", epicRef: "6", worktreeRoot }),
    ).rejects.toBeInstanceOf(WorktreeError);
  });
});
