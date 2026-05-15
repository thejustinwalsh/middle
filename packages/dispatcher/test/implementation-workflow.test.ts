import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, HookPayload, StopClassification } from "@middle/core";
import { Engine } from "bunqueue/workflow";
import { openAndMigrate } from "../src/db.ts";
import type { SessionGate } from "../src/hook-server.ts";
import { getWorkflow } from "../src/workflow-record.ts";
import {
  createImplementationWorkflow,
  type ImplementationDeps,
} from "../src/workflows/implementation.ts";
import { createWorktree, destroyWorktree, listWorktrees } from "../src/worktree.ts";

let scratch: string;
let repoPath: string;
let worktreeRoot: string;
let db: Database;
let engine: Engine;

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  }
}

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "middle-wf-")));
  repoPath = join(scratch, "repo");
  worktreeRoot = join(scratch, "worktrees");
  await git(scratch, ["init", "repo"]);
  await git(repoPath, ["commit", "--allow-empty", "-m", "init"]);
  db = openAndMigrate(join(scratch, "db.sqlite3"));
  // No dataPath → bunqueue's queue + workflow store are in-memory: isolated per
  // engine, no filesystem vnode churn under the test's temp dir.
  engine = new Engine({ embedded: true });
});

afterEach(async () => {
  await engine.close(true);
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** A tmux stub that records every session it is asked to create and kill. */
function makeTmuxStub() {
  const created: string[] = [];
  const killed: string[] = [];
  return {
    created,
    killed,
    ops: {
      async newSession(opts: { sessionName: string }) {
        created.push(opts.sessionName);
      },
      async sendText() {},
      async sendEnter() {},
      async killSession(sessionName: string) {
        killed.push(sessionName);
      },
    },
  };
}

/** A SessionGate stub that resolves both events immediately. */
const readyGate: SessionGate = {
  awaitSessionStart: async () =>
    ({ session_id: "stub-session", transcript_path: "/tmp/stub.jsonl" }) as HookPayload,
  awaitStop: async () => ({ reason: "turn-end" }) as HookPayload,
};

/** A minimal AgentAdapter stub with a configurable classifyStop outcome. */
function makeAdapterStub(classification: StopClassification): AgentAdapter {
  return {
    name: "stub",
    readyEvent: "session.started",
    async installHooks() {},
    buildLaunchCommand: () => ({ argv: ["true"], env: {} }),
    buildPromptText: () => "@.middle/prompt.md",
    async enterAutoMode() {},
    resolveTranscriptPath: (payload) => payload.transcript_path as string,
    readTranscriptState: () => ({
      lastActivity: "",
      contextTokens: 0,
      turnCount: 0,
      lastToolUse: null,
    }),
    classifyStop: () => classification,
  };
}

function makeDeps(overrides: Partial<ImplementationDeps>): ImplementationDeps {
  return {
    db,
    getAdapter: () => makeAdapterStub({ kind: "done" }),
    sessionGate: readyGate,
    tmux: makeTmuxStub().ops,
    worktree: { createWorktree, destroyWorktree },
    resolveRepoPath: () => repoPath,
    worktreeRoot,
    dispatcherUrl: "http://127.0.0.1:8822",
    launchTimeoutMs: 2000,
    stopTimeoutMs: 2000,
    ...overrides,
  };
}

/** No session leak: every tmux session that was created was also killed. */
function expectNoSessionLeak(tmux: { created: string[]; killed: string[] }): void {
  expect(tmux.created.length).toBeGreaterThanOrEqual(1);
  for (const session of new Set(tmux.created)) {
    expect(tmux.killed).toContain(session);
  }
}

async function runToEnd(deps: ImplementationDeps): Promise<string> {
  engine.register(createImplementationWorkflow(deps));
  const handle = await engine.start("implementation", {
    repo: "thejustinwalsh/middle",
    epicNumber: 6,
    adapter: "stub",
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const execution = engine.getExecution(handle.id);
    if (execution && execution.state !== "running" && execution.state !== "compensating") {
      return handle.id;
    }
    await Bun.sleep(15);
  }
  throw new Error("workflow did not settle within 5s");
}

describe("implementation workflow — happy path", () => {
  test("runs prepare → drive → cleanup, ends 'completed', leaks nothing", async () => {
    const tmux = makeTmuxStub();
    const deps = makeDeps({
      tmux: tmux.ops,
      getAdapter: () => makeAdapterStub({ kind: "done" }),
    });
    const id = await runToEnd(deps);

    const record = getWorkflow(db, id)!;
    expect(record.state).toBe("completed");
    expect(record.epicNumber).toBe(6);
    expect(record.sessionName).toBe("middle-6");
    expect(record.sessionId).toBe("stub-session");
    expect(record.transcriptPath).toBe("/tmp/stub.jsonl");

    // no worktree leak
    expect(await listWorktrees({ repoPath, worktreeRoot })).toEqual([]);
    // no session leak — every created session was killed
    expectNoSessionLeak(tmux);
  });

  test("a 'failed' classifyStop ends the workflow 'failed' but still cleans up", async () => {
    const tmux = makeTmuxStub();
    const deps = makeDeps({
      tmux: tmux.ops,
      getAdapter: () => makeAdapterStub({ kind: "failed", reason: "stub failure" }),
    });
    const id = await runToEnd(deps);

    expect(getWorkflow(db, id)!.state).toBe("failed");
    expect(await listWorktrees({ repoPath, worktreeRoot })).toEqual([]);
    expectNoSessionLeak(tmux);
  });
});

describe("implementation workflow — compensation", () => {
  test("a launch failure compensates: worktree rolled back, session freed, state 'compensated'", async () => {
    const tmux = makeTmuxStub();
    const failingGate: SessionGate = {
      awaitSessionStart: async () => {
        throw new Error("launch timeout");
      },
      awaitStop: async () => ({}) as HookPayload,
    };
    const deps = makeDeps({ tmux: tmux.ops, sessionGate: failingGate });

    engine.register(createImplementationWorkflow(deps));
    const handle = await engine.start("implementation", {
      repo: "thejustinwalsh/middle",
      epicNumber: 6,
      adapter: "stub",
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const execution = engine.getExecution(handle.id);
      if (execution && execution.state !== "running" && execution.state !== "compensating") break;
      await Bun.sleep(15);
    }

    expect(getWorkflow(db, handle.id)!.state).toBe("compensated");
    expect(await listWorktrees({ repoPath, worktreeRoot })).toEqual([]);
    expectNoSessionLeak(tmux);
  });
});
