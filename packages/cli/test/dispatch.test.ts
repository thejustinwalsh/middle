import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDispatch } from "../src/commands/dispatch.ts";

type BunServer = ReturnType<typeof Bun.serve>;

// `mm dispatch` is a thin client of the daemon's control plane: probe /health
// (auto-starting the daemon if down), POST /control/dispatch, then stream
// /control/events until the workflow settles or parks. The full happy path
// (a real Claude session in tmux) is verified manually; these tests cover input
// validation and the client/daemon protocol against a fake daemon.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "middle-cli-dispatch-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function silenceLogs(): () => void {
  const err = spyOn(console, "error").mockImplementation(() => {});
  const log = spyOn(console, "log").mockImplementation(() => {});
  return () => {
    err.mockRestore();
    log.mockRestore();
  };
}

/** A real git repo at `<dir>/repo` so input validation (and the slug) pass. */
function makeRepo(): string {
  const repoPath = join(realpathSync(dir), "repo");
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "middle-test",
    GIT_AUTHOR_EMAIL: "middle-test@example.invalid",
    GIT_COMMITTER_NAME: "middle-test",
    GIT_COMMITTER_EMAIL: "middle-test@example.invalid",
  };
  const init = Bun.spawnSync(["git", "init", repoPath]);
  expect(init.exitCode).toBe(0);
  const commit = Bun.spawnSync(["git", "-C", repoPath, "commit", "--allow-empty", "-m", "init"], {
    env: gitEnv,
  });
  expect(commit.exitCode).toBe(0);
  return repoPath;
}

function writeConfig(port: number | undefined): string {
  const configPath = join(dir, "config.toml");
  writeFileSync(
    configPath,
    [
      "[global]",
      `dispatcher_port = ${port}`,
      `db_path = "${join(dir, "db.sqlite3")}"`,
      `worktree_root = "${join(dir, "worktrees")}"`,
      `log_dir = "${join(dir, "logs")}"`,
      "",
    ].join("\n"),
  );
  return configPath;
}

/** SSE frame for a workflow state transition. */
function sseWorkflow(id: string, state: string): string {
  return `event: workflow\ndata: ${JSON.stringify({ id, repo: "repo", epic: 6, state })}\n\n`;
}

type FakeDaemonOpts = {
  /** Ordered states broadcast to a /control/events subscriber after `connected`. */
  states: string[];
  /** The id assigned by /control/dispatch (defaults wf-1). */
  workflowId?: string;
};

/** A fake daemon exposing /health, /control/dispatch, /control/events. */
function fakeDaemon(opts: FakeDaemonOpts): {
  server: BunServer;
  dispatchBodies: unknown[];
  requestOrder: string[];
} {
  const dispatchBodies: unknown[] = [];
  const requestOrder: string[] = [];
  const workflowId = opts.workflowId ?? "wf-1";
  let server: BunServer;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req): Promise<Response> {
      const { pathname } = new URL(req.url);
      if (req.method === "GET" && pathname === "/health") {
        return Response.json({ ok: true, port: server.port, version: "test" });
      }
      if (req.method === "POST" && pathname === "/control/dispatch") {
        requestOrder.push("dispatch");
        dispatchBodies.push(await req.json());
        return Response.json({ workflowId });
      }
      if (req.method === "GET" && pathname === "/control/events") {
        requestOrder.push("events");
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode("event: connected\ndata: {}\n\n"));
            for (const state of opts.states) {
              controller.enqueue(enc.encode(sseWorkflow(workflowId, state)));
            }
            // Keep the stream open so the client exits on the state, not on stream-end.
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, dispatchBodies, requestOrder };
}

describe("runDispatch — input validation", () => {
  test("rejects a non-integer epic number", async () => {
    const restore = silenceLogs();
    try {
      expect(await runDispatch(dir, "not-a-number")).toBe(1);
    } finally {
      restore();
    }
  });

  test("rejects an epic number below 1", async () => {
    const restore = silenceLogs();
    try {
      expect(await runDispatch(dir, "0")).toBe(1);
    } finally {
      restore();
    }
  });

  test("rejects a path that is not a git repository", async () => {
    const restore = silenceLogs();
    try {
      expect(await runDispatch(dir, "6")).toBe(1);
    } finally {
      restore();
    }
  });
});

describe("runDispatch — control client", () => {
  test("health already up: dispatches and exits 0 on completed, without spawning a daemon", async () => {
    const repoPath = makeRepo();
    const { server, dispatchBodies } = fakeDaemon({ states: ["running", "completed"] });
    const configPath = writeConfig(server.port);
    let spawned = false;
    const restore = silenceLogs();
    try {
      const code = await runDispatch(repoPath, "6", {
        configPath,
        startDaemon: () => {
          spawned = true;
          return 0;
        },
      });
      expect(code).toBe(0);
      expect(spawned).toBe(false); // health was up → never spawned
      expect(dispatchBodies).toEqual([
        { repo: "repo", repoPath, epicNumber: 6, adapter: "claude" },
      ]);
    } finally {
      restore();
      server.stop(true);
    }
  });

  test("subscribes to /control/events BEFORE POSTing /control/dispatch", async () => {
    // Guards the race: a fast-failing workflow emits its terminal frame on the
    // next tick and init-replay omits terminal states, so the client must be
    // subscribed before it dispatches or it hangs forever.
    const repoPath = makeRepo();
    const { server, requestOrder } = fakeDaemon({ states: ["completed"] });
    const configPath = writeConfig(server.port);
    const restore = silenceLogs();
    try {
      expect(await runDispatch(repoPath, "6", { configPath, startDaemon: () => 0 })).toBe(0);
      expect(requestOrder[0]).toBe("events");
      expect(requestOrder).toContain("dispatch");
      expect(requestOrder.indexOf("events")).toBeLessThan(requestOrder.indexOf("dispatch"));
    } finally {
      restore();
      server.stop(true);
    }
  });

  test("exits 0 when the workflow parks for review (waiting-human)", async () => {
    const repoPath = makeRepo();
    const { server } = fakeDaemon({ states: ["running", "waiting-human"] });
    const configPath = writeConfig(server.port);
    const restore = silenceLogs();
    try {
      expect(await runDispatch(repoPath, "6", { configPath, startDaemon: () => 0 })).toBe(0);
    } finally {
      restore();
      server.stop(true);
    }
  });

  test("exits 1 when the workflow fails", async () => {
    const repoPath = makeRepo();
    const { server } = fakeDaemon({ states: ["running", "failed"] });
    const configPath = writeConfig(server.port);
    const restore = silenceLogs();
    try {
      expect(await runDispatch(repoPath, "6", { configPath, startDaemon: () => 0 })).toBe(1);
    } finally {
      restore();
      server.stop(true);
    }
  });

  test("reconnects when the event stream drops mid-flight and follows to completion", async () => {
    const repoPath = makeRepo();
    let eventsConnections = 0;
    let server: BunServer;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req): Promise<Response> {
        const { pathname } = new URL(req.url);
        if (req.method === "GET" && pathname === "/health") {
          return Response.json({ ok: true, port: server.port, version: "test" });
        }
        if (req.method === "POST" && pathname === "/control/dispatch") {
          await req.json();
          return Response.json({ workflowId: "wf-1" });
        }
        if (req.method === "GET" && pathname === "/control/events") {
          eventsConnections += 1;
          const first = eventsConnections === 1;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const enc = new TextEncoder();
              controller.enqueue(enc.encode("event: connected\ndata: {}\n\n"));
              if (first) {
                // An in-flight frame, then sever the stream (simulating a drop).
                controller.enqueue(enc.encode(sseWorkflow("wf-1", "running")));
                controller.close();
              } else {
                // The reconnect carries the terminal verdict.
                controller.enqueue(enc.encode(sseWorkflow("wf-1", "completed")));
              }
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const configPath = writeConfig(server.port);
    const restore = silenceLogs();
    try {
      const code = await runDispatch(repoPath, "6", {
        configPath,
        startDaemon: () => 0,
        reconnectBackoffMs: 1, // don't actually wait between reconnects
      });
      expect(code).toBe(0);
      expect(eventsConnections).toBeGreaterThanOrEqual(2); // it reconnected, not gave up
    } finally {
      restore();
      server.stop(true);
    }
  });

  test("friendly failure (exit 1) when the daemon can't be reached or started", async () => {
    const repoPath = makeRepo();
    // A port with nothing listening.
    const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    const port = dead.port;
    dead.stop(true);
    const configPath = writeConfig(port);
    const errLines: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) =>
      errLines.push(a.join(" ")),
    );
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await runDispatch(repoPath, "6", {
        configPath,
        startDaemon: () => 0, // pretends to start, but nothing comes up
        healthTimeoutMs: 400,
      });
      expect(code).toBe(1);
      expect(errLines.join("\n")).toContain("mm dispatch:");
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
