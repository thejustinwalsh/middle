import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktree,
  destroyWorktree,
  listWorktrees,
  WorktreeError,
} from "../src/worktree.ts";

let scratch: string;
let repoPath: string;
let worktreeRoot: string;

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
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
      issueNumber: 6,
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
    await createWorktree({ repoPath, repo: "o/r", issueNumber: 6, worktreeRoot });
    await createWorktree({ repoPath, repo: "o/r", issueNumber: 7, worktreeRoot });
    const listed = await listWorktrees({ repoPath, worktreeRoot });
    expect(listed.map((w) => w.unit).sort()).toEqual(["issue-6", "issue-7"]);
    expect(listed.every((w) => w.repo === "o/r")).toBe(true);
  });

  test("destroy removes the worktree directory and its branch", async () => {
    const handle = await createWorktree({ repoPath, repo: "o/r", issueNumber: 6, worktreeRoot });
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
    const first = await createWorktree({ repoPath, repo: "o/r", issueNumber: 6, worktreeRoot });
    const second = await createWorktree({ repoPath, repo: "o/r", issueNumber: 6, worktreeRoot });
    expect(second).toEqual(first);
  });

  test("destroying an already-removed worktree is a no-op, not a throw", async () => {
    const handle = await createWorktree({ repoPath, repo: "o/r", issueNumber: 6, worktreeRoot });
    await destroyWorktree(handle);
    await destroyWorktree(handle); // must not throw
    expect(existsSync(handle.path)).toBe(false);
  });
});

describe("failure surfacing", () => {
  test("create against a non-git directory throws WorktreeError", async () => {
    await expect(
      createWorktree({ repoPath: scratch, repo: "o/r", issueNumber: 6, worktreeRoot }),
    ).rejects.toBeInstanceOf(WorktreeError);
  });
});
