import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createDbDeps } from "../src/db-deps.ts";
import { createDashboardServer } from "../src/server.ts";
import type { RepoDetail, RepoSummary, RunnerPanel } from "../src/wire.ts";
import { makeConfig, makeDb, seedWorkflow } from "./helpers.ts";

// The JSON API end-to-end: a real `Bun.serve` on an ephemeral port, the
// db-backed deps over a migrated temp db. `serveSpa: false` keeps the bundler
// out of these tests. The terminal spawn is stubbed so attach never opens a
// real window.

let db: Database;
let cleanup: () => void;
let server: Awaited<ReturnType<typeof createDashboardServer>>;
let base: string;
let spawnedCommands: string[];

async function start(): Promise<void> {
  spawnedCommands = [];
  const deps = createDbDeps({
    db,
    config: makeConfig(),
    spawnTerminal: (cmd) => {
      spawnedCommands.push(cmd);
      return true;
    },
    isSessionAlive: async () => true,
  });
  server = await createDashboardServer({ deps, port: 0, serveSpa: false });
  base = `http://127.0.0.1:${server.port}`;
}

beforeEach(() => {
  const made = makeDb();
  db = made.db;
  cleanup = made.cleanup;
});

afterEach(() => {
  server.stop(true);
  cleanup();
});

describe("dashboard JSON API", () => {
  test("GET /api/repos returns a JSON array of repo summaries", async () => {
    seedWorkflow(db, { id: "w1", repo: "o/alpha", adapter: "claude", state: "running" });
    seedWorkflow(db, { id: "w2", repo: "o/alpha", adapter: "claude", state: "running" });
    await start();

    const res = await fetch(`${base}/api/repos`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const repos = (await res.json()) as RepoSummary[];
    expect(Array.isArray(repos)).toBe(true);
    const alpha = repos.find((r) => r.repo === "o/alpha");
    expect(alpha).toBeDefined();
    // Two running claude workflows → claude pill 2/2, repo total 2/3, auto on.
    expect(alpha?.total).toEqual({ used: 2, max: 3 });
    expect(alpha?.adapters.find((a) => a.adapter === "claude")).toEqual({
      adapter: "claude",
      used: 2,
      max: 2,
    });
    expect(alpha?.auto).toBe(true);
  });

  test("GET /api/repos/:repo returns NEXT UP + IN FLIGHT for a known repo", async () => {
    seedWorkflow(db, {
      id: "w1",
      repo: "o/alpha",
      epicNumber: 7,
      state: "running",
      sessionName: "sess-7",
      currentSubIssue: 2,
    });
    await start();

    const res = await fetch(`${base}/api/repos/${encodeURIComponent("o/alpha")}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as RepoDetail;
    expect(detail.repo).toBe("o/alpha");
    expect(detail.inFlight).toHaveLength(1);
    expect(detail.inFlight[0]).toMatchObject({
      session: "sess-7",
      epic: 7,
      progress: "sub-issue 2",
      controlledBy: "middle",
    });
    expect(detail.nextUp).toEqual([]); // no state gateway wired
  });

  test("GET /api/repos/:repo 404s an unknown repo", async () => {
    await start();
    const res = await fetch(`${base}/api/repos/${encodeURIComponent("o/missing")}`);
    expect(res.status).toBe(404);
  });

  test("GET /api/banner reports per-adapter rate limits (UNKNOWN unobserved)", async () => {
    await start();
    const res = await fetch(`${base}/api/banner`);
    expect(res.status).toBe(200);
    const banner = (await res.json()) as {
      adapters: { adapter: string; status: string }[];
      github: { status: string };
    };
    expect(banner.adapters.map((a) => a.adapter).sort()).toEqual(["claude", "codex"]);
    expect(banner.adapters.every((a) => a.status === "UNKNOWN")).toBe(true);
    expect(banner.github.status).toBe("UNKNOWN");
  });

  test("GET /api/sessions/:session returns the Inspector runner panel with attach commands", async () => {
    seedWorkflow(db, {
      id: "w1",
      repo: "o/alpha",
      epicNumber: 7,
      state: "running",
      sessionName: "sess-7",
      prNumber: 42,
      worktreePath: "/wt/alpha-7",
    });
    await start();

    const res = await fetch(`${base}/api/sessions/sess-7`);
    expect(res.status).toBe(200);
    const panel = (await res.json()) as RunnerPanel;
    expect(panel).toMatchObject({
      session: "sess-7",
      repo: "o/alpha",
      epic: 7,
      alive: true,
      prNumber: 42,
      worktreePath: "/wt/alpha-7",
      controlledBy: "middle",
    });
    expect(panel.attachCommands.watch).toBe("tmux attach -r -t 'sess-7'");
    expect(panel.attachCommands.control).toBe("tmux attach -t 'sess-7'");
  });

  test("POST /api/sessions/:session/attach control flips controlled_by and spawns a terminal", async () => {
    seedWorkflow(db, { id: "w1", repo: "o/alpha", state: "running", sessionName: "sess-7" });
    await start();

    const res = await fetch(`${base}/api/sessions/sess-7/attach`, {
      method: "POST",
      body: JSON.stringify({ mode: "control" }),
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as { mode: string; spawned: boolean; controlledBy: string };
    expect(result).toMatchObject({ mode: "control", spawned: true, controlledBy: "human" });
    expect(spawnedCommands).toEqual(["tmux attach -t 'sess-7'"]);

    // The flip is persisted: the panel now reads human, and release reverts it.
    const panel = (await (await fetch(`${base}/api/sessions/sess-7`)).json()) as RunnerPanel;
    expect(panel.controlledBy).toBe("human");

    const rel = await fetch(`${base}/api/sessions/sess-7/release`, { method: "POST" });
    expect(rel.status).toBe(200);
    const after = (await (await fetch(`${base}/api/sessions/sess-7`)).json()) as RunnerPanel;
    expect(after.controlledBy).toBe("middle");
  });

  test("POST /api/sessions/:session/attach rejects an invalid mode", async () => {
    seedWorkflow(db, { id: "w1", repo: "o/alpha", state: "running", sessionName: "sess-7" });
    await start();
    const res = await fetch(`${base}/api/sessions/sess-7/attach`, {
      method: "POST",
      body: JSON.stringify({ mode: "sudo" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/rate-limits/:adapter/clear sets the adapter AVAILABLE", async () => {
    await start();
    const res = await fetch(`${base}/api/rate-limits/claude/clear`, { method: "POST" });
    expect(res.status).toBe(200);
    const banner = (await (await fetch(`${base}/api/banner`)).json()) as {
      adapters: { adapter: string; status: string }[];
    };
    expect(banner.adapters.find((a) => a.adapter === "claude")?.status).toBe("AVAILABLE");
  });

  test("unknown /api routes 404 as JSON", async () => {
    await start();
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toHaveProperty("error");
  });
});
