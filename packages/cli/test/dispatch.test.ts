import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDispatch } from "../src/commands/dispatch.ts";

type BunServer = ReturnType<typeof Bun.serve>;

// The full `mm dispatch` happy path spawns a real Claude session in tmux and is
// verified manually (see the reviewer's brief). These tests cover the input
// validation that fails fast, before any process is spawned.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "middle-cli-dispatch-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function silenceError(): () => void {
  const err = spyOn(console, "error").mockImplementation(() => {});
  return () => err.mockRestore();
}

describe("runDispatch — input validation", () => {
  test("rejects a non-integer epic number", async () => {
    const restore = silenceError();
    try {
      expect(await runDispatch(dir, "not-a-number")).toBe(1);
    } finally {
      restore();
    }
  });

  test("rejects an epic number below 1", async () => {
    const restore = silenceError();
    try {
      expect(await runDispatch(dir, "0")).toBe(1);
    } finally {
      restore();
    }
  });

  test("rejects a path that is not a git repository", async () => {
    const restore = silenceError();
    try {
      expect(await runDispatch(dir, "6")).toBe(1);
    } finally {
      restore();
    }
  });
});

describe("runDispatch — dispatchEpic failure path", () => {
  test("surfaces a friendly 'mm dispatch: failed —' message and returns 1 on EADDRINUSE", async () => {
    // make `repoPath` a real git repo so input validation passes
    const repoPath = join(realpathSync(dir), "repo");
    {
      const init = Bun.spawn(["git", "init", repoPath], { stdout: "ignore", stderr: "ignore" });
      await init.exited;
      const commit = Bun.spawn(
        ["git", "-C", repoPath, "commit", "--allow-empty", "-m", "init"],
        { stdout: "ignore", stderr: "ignore" },
      );
      await commit.exited;
    }

    // bind the port so dispatchEpic's hookServer.start() throws EADDRINUSE
    const blocker: BunServer = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const configPath = join(dir, "config.toml");
    writeFileSync(
      configPath,
      [
        "[global]",
        `dispatcher_port = ${blocker.port}`,
        `db_path = "${join(dir, "db.sqlite3")}"`,
        `worktree_root = "${join(dir, "worktrees")}"`,
        `log_dir = "${join(dir, "logs")}"`,
        "",
      ].join("\n"),
    );

    const errLines: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errLines.push(args.join(" "));
    });
    try {
      const code = await runDispatch(repoPath, "6", { configPath });
      expect(code).toBe(1);
      expect(errLines.join("\n")).toContain("mm dispatch: failed");
    } finally {
      errSpy.mockRestore();
      blocker.stop(true);
    }
  });
});
