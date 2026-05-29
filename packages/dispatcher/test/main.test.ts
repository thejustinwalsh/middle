import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Verifies the dispatcher process entrypoint that `mm start` spawns and
// `mm stop` signals: it stands up the hook server + control plane, announces
// readiness, hosts a dispatch on its own engine (broadcasting a workflow SSE
// event), and shuts down cleanly on SIGTERM.

let dir: string;
let configPath: string;
const mainEntrypoint = join(import.meta.dir, "..", "src", "main.ts");

/** Spawn the daemon, wait for the readiness line, and return its process + resolved port. */
async function startDaemon(): Promise<{ proc: Bun.Subprocess; port: number }> {
  const proc = Bun.spawn(["bun", mainEntrypoint], {
    env: { ...process.env, MIDDLE_CONFIG: configPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + 5000;
  while (!output.includes("dispatcher up") && Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      Bun.sleep(deadline - Date.now()).then(() => "timed-out" as const),
    ]);
    if (typeof result === "string") break;
    if (result.done) break;
    output += decoder.decode(result.value);
  }
  reader.releaseLock();
  const match = /hooks on :(\d+)/.exec(output);
  if (!match) {
    proc.kill("SIGKILL");
    throw new Error(`daemon did not announce readiness: ${output}`);
  }
  return { proc, port: Number(match[1]) };
}

/** Read SSE frames off a Response body until one satisfies `done`, or a deadline. */
async function readUntil(
  res: Response,
  done: (frame: string) => boolean,
  deadlineMs = 8000,
): Promise<string | null> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + deadlineMs;
  try {
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        Bun.sleep(deadline - Date.now()).then(() => "timeout" as const),
      ]);
      if (result === "timeout" || result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx + 2);
        buffer = buffer.slice(idx + 2);
        if (done(frame)) return frame;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return null;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "middle-main-"));
  configPath = join(dir, "config.toml");
  writeFileSync(
    configPath,
    [
      "[global]",
      "dispatcher_port = 0", // ephemeral — main.ts prints the resolved port
      `db_path = "${join(dir, "db.sqlite3")}"`,
      `worktree_root = "${join(dir, "worktrees")}"`,
      `log_dir = "${join(dir, "logs")}"`,
      "",
    ].join("\n"),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("dispatcher main", () => {
  test("starts the hook server, announces readiness, and exits 0 on SIGTERM", async () => {
    const proc = Bun.spawn(["bun", mainEntrypoint], {
      env: { ...process.env, MIDDLE_CONFIG: configPath },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      // Wait for the readiness line, with a real wall-clock cap: race each
      // read against the remaining time so a blocking read can't outlast the
      // deadline.
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let output = "";
      const deadline = Date.now() + 5000;
      while (!output.includes("dispatcher up") && Date.now() < deadline) {
        const result = await Promise.race([
          reader.read(),
          Bun.sleep(deadline - Date.now()).then(() => "timed-out" as const),
        ]);
        if (typeof result === "string") break; // timed out
        if (result.done) break;
        output += decoder.decode(result.value);
      }
      reader.releaseLock();
      expect(output).toContain("middle dispatcher up");

      proc.kill("SIGTERM");
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    } finally {
      // Always reap the spawned dispatcher, even if an assertion above threw.
      proc.kill("SIGKILL");
    }
  });

  test("hosts a dispatch on its own engine and broadcasts a workflow SSE event", async () => {
    // createWorktree needs a real git repo with a commit at repoPath.
    const repoPath = join(realpathSync(dir), "repo");
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "middle-test",
      GIT_AUTHOR_EMAIL: "middle-test@example.invalid",
      GIT_COMMITTER_NAME: "middle-test",
      GIT_COMMITTER_EMAIL: "middle-test@example.invalid",
    };
    expect(
      await Bun.spawn(["git", "init", repoPath], { stdout: "ignore", stderr: "ignore" }).exited,
    ).toBe(0);
    expect(
      await Bun.spawn(["git", "-C", repoPath, "commit", "--allow-empty", "-m", "init"], {
        stdout: "ignore",
        stderr: "ignore",
        env: gitEnv,
      }).exited,
    ).toBe(0);

    const { proc, port } = await startDaemon();
    try {
      const base = `http://127.0.0.1:${port}`;

      // Subscribe to the control feed first, draining the `connected` frame so
      // we're live before the dispatch broadcasts.
      const events = await fetch(`${base}/control/events`);
      expect(events.status).toBe(200);

      const dispatch = await fetch(`${base}/control/dispatch`, {
        method: "POST",
        body: JSON.stringify({ repo: "o/r", repoPath, epicNumber: 42, adapter: "claude" }),
      });
      expect(dispatch.status).toBe(200);
      const { workflowId } = (await dispatch.json()) as { workflowId: string };
      expect(typeof workflowId).toBe("string");

      // A `workflow` event for our dispatch must arrive on the feed.
      const frame = await readUntil(
        events,
        (f) => f.includes("event: workflow") && f.includes(workflowId),
      );
      expect(frame).not.toBeNull();

      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(0);
    } finally {
      proc.kill("SIGKILL");
    }
  }, 20_000);

  test("a terminal prepare-worktree failure marks the row failed, so the next dispatch isn't 409-blocked (issue #179)", async () => {
    // repoPath exists but is NOT a git repo, so createWorktree fails terminally
    // (after its retries). The row would otherwise strand at `pending` and
    // 409-block every re-dispatch of this Epic; the daemon promotes the orphan
    // to `failed` off bunqueue's `workflow:failed`, freeing the next dispatch.
    const notARepo = join(realpathSync(dir), "not-a-repo");
    mkdirSync(notARepo, { recursive: true });

    const { proc, port } = await startDaemon();
    try {
      const base = `http://127.0.0.1:${port}`;
      const events = await fetch(`${base}/control/events`);
      expect(events.status).toBe(200);

      const body = JSON.stringify({
        repo: "o/r",
        repoPath: notARepo,
        epicNumber: 77,
        adapter: "claude",
      });
      const first = await fetch(`${base}/control/dispatch`, { method: "POST", body });
      expect(first.status).toBe(200);
      const { workflowId } = (await first.json()) as { workflowId: string };

      // Wait until the orphan has been promoted to `failed` on the feed.
      const failedFrame = await readUntil(
        events,
        (f) =>
          f.includes("event: workflow") && f.includes(workflowId) && f.includes('"state":"failed"'),
        15_000,
      );
      expect(failedFrame).not.toBeNull();

      // The Epic's row is terminal now → a re-dispatch is accepted (200), not the
      // 409 "already has an active workflow" a stranded `pending` row would force.
      const second = await fetch(`${base}/control/dispatch`, { method: "POST", body });
      expect(second.status).toBe(200);

      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(0);
    } finally {
      proc.kill("SIGKILL");
    }
  }, 30_000);

  test("daemon rejects a disabled adapter on /control/dispatch (configured+enabled+implemented gate)", async () => {
    // Override codex to disabled in this test's config; claude stays on (default).
    writeFileSync(
      configPath,
      [
        "[global]",
        "dispatcher_port = 0",
        `db_path = "${join(dir, "db.sqlite3")}"`,
        `worktree_root = "${join(dir, "worktrees")}"`,
        `log_dir = "${join(dir, "logs")}"`,
        "",
        "[adapters.codex]",
        "enabled = false",
        "",
      ].join("\n"),
    );
    const repoPath = join(realpathSync(dir), "repo-disabled");
    expect(
      await Bun.spawn(["git", "init", repoPath], { stdout: "ignore", stderr: "ignore" }).exited,
    ).toBe(0);

    const { proc, port } = await startDaemon();
    try {
      const base = `http://127.0.0.1:${port}`;
      const body = (adapter: string) =>
        JSON.stringify({ repo: "o/r", repoPath, epicNumber: 88, adapter });

      // Disabled-but-implemented adapter — must 400 with a "disabled" reason,
      // NOT "unknown adapter": the route reaches the daemon below the CLI gate
      // (a direct POST or a dashboard call), so the daemon owns this check.
      const disabled = await fetch(`${base}/control/dispatch`, {
        method: "POST",
        body: body("codex"),
      });
      expect(disabled.status).toBe(400);
      expect(await disabled.json()).toEqual({ error: "adapter codex is disabled in config" });

      // Unimplemented adapter — still 400, with the distinct "unknown" wording
      // (so an operator can tell a typo from a deliberate disable).
      const unknown = await fetch(`${base}/control/dispatch`, {
        method: "POST",
        body: body("nonexistent"),
      });
      expect(unknown.status).toBe(400);
      expect(await unknown.json()).toEqual({ error: "unknown adapter: nonexistent" });

      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(0);
    } finally {
      proc.kill("SIGKILL");
    }
  }, 20_000);

  test("two concurrent dispatches of the same Epic: exactly one starts, the other 409s", async () => {
    const repoPath = join(realpathSync(dir), "repo-concurrent");
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "middle-test",
      GIT_AUTHOR_EMAIL: "middle-test@example.invalid",
      GIT_COMMITTER_NAME: "middle-test",
      GIT_COMMITTER_EMAIL: "middle-test@example.invalid",
    };
    expect(
      await Bun.spawn(["git", "init", repoPath], { stdout: "ignore", stderr: "ignore" }).exited,
    ).toBe(0);
    expect(
      await Bun.spawn(["git", "-C", repoPath, "commit", "--allow-empty", "-m", "init"], {
        stdout: "ignore",
        stderr: "ignore",
        env: gitEnv,
      }).exited,
    ).toBe(0);

    const { proc, port } = await startDaemon();
    try {
      const base = `http://127.0.0.1:${port}`;
      const body = JSON.stringify({ repo: "o/r", repoPath, epicNumber: 77, adapter: "claude" });
      // Fire both before either can settle: the atomic reserve in startDispatch
      // must let exactly one through and 409 the other (no double-start that
      // would clash on the deterministic tmux session + worktree).
      const [a, b] = await Promise.all([
        fetch(`${base}/control/dispatch`, { method: "POST", body }),
        fetch(`${base}/control/dispatch`, { method: "POST", body }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);

      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(0);
    } finally {
      proc.kill("SIGKILL");
    }
  }, 20_000);
});
