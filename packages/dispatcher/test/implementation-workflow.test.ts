import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, HookPayload, StopClassification } from "@middle/core";
import { Engine } from "bunqueue/workflow";
import { openAndMigrate } from "../src/db.ts";
import type { SessionGate } from "../src/hook-server.ts";
import { getRateLimitState, setRateLimited } from "../src/rate-limits.ts";
import { getWaitForSignal, getWorkflow } from "../src/workflow-record.ts";
import {
  createImplementationWorkflow,
  RESUME_EVENT,
  signalNameFor,
  type ImplementationDeps,
} from "../src/workflows/implementation.ts";
import { createWorktree, destroyWorktree, listWorktrees } from "../src/worktree.ts";

let scratch: string;
let repoPath: string;
let worktreeRoot: string;
let db: Database;
let engine: Engine;

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

/**
 * A minimal AgentAdapter stub. `classifyStop` returns each supplied
 * classification in turn (one per drive); the last value repeats — so a single
 * value behaves as a constant, and a `[asked-question, done]` pair models a
 * park that resumes to completion. `prompts` records every `buildPromptText`
 * kind so tests can assert resume framing.
 */
function makeAdapterStub(
  classifications: StopClassification | StopClassification[],
  prompts: string[] = [],
): AgentAdapter {
  const seq = Array.isArray(classifications) ? [...classifications] : [classifications];
  let i = 0;
  return {
    name: "stub",
    readyEvent: "session.started",
    async installHooks() {},
    buildLaunchCommand: () => ({ argv: ["true"], env: {} }),
    buildPromptText: (opts) => {
      prompts.push(opts.kind);
      return `@.middle/prompt.md (${opts.kind})`;
    },
    async enterAutoMode() {},
    resolveTranscriptPath: (payload) => payload.transcript_path as string,
    readTranscriptState: () => ({
      lastActivity: "",
      contextTokens: 0,
      turnCount: 0,
      lastToolUse: null,
    }),
    classifyStop: () => seq[Math.min(i++, seq.length - 1)]!,
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

const EPIC = 6;
const INPUT = { repo: "thejustinwalsh/middle", epicNumber: EPIC, adapter: "stub" };

async function start(deps: ImplementationDeps): Promise<string> {
  engine.register(createImplementationWorkflow(deps));
  const handle = await engine.start("implementation", INPUT);
  return handle.id;
}

/**
 * Wait until the execution is genuinely parked on the `waitFor` node — bunqueue
 * `exec.state === 'waiting'`. Signalling before the branch has advanced to the
 * `waitFor` would race the park; in production the poller only fires after a
 * real reply, long after parking. Asserts the `workflows` row reads
 * `waiting-human` once parked.
 */
async function awaitParked(id: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (engine.getExecution(id)?.state === "waiting") {
      expect(getWorkflow(db, id)?.state).toBe("waiting-human");
      return;
    }
    await Bun.sleep(15);
  }
  throw new Error(
    `workflow ${id} did not park within ${timeoutMs}ms (exec '${engine.getExecution(id)?.state}', row '${getWorkflow(db, id)?.state}')`,
  );
}

/** Run the engine until the workflow row reaches a terminal-ish state. */
async function awaitSettled(id: string, timeoutMs = 5000): Promise<string> {
  const terminal = new Set(["completed", "failed", "rate-limited", "compensated", "cancelled"]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = getWorkflow(db, id)?.state;
    if (s && terminal.has(s)) return s;
    await Bun.sleep(15);
  }
  throw new Error(`workflow ${id} did not settle within ${timeoutMs}ms (was '${getWorkflow(db, id)?.state}')`);
}

describe("implementation workflow — terminal stops fall through the waitFor", () => {
  test("a 'failed' classifyStop ends 'failed', destroys the worktree, leaks no session", async () => {
    const tmux = makeTmuxStub();
    const deps = makeDeps({
      tmux: tmux.ops,
      getAdapter: () => makeAdapterStub({ kind: "failed", reason: "stub failure" }),
    });
    const id = await start(deps);

    expect(await awaitSettled(id)).toBe("failed");
    expect(getWaitForSignal(db, id)).toBeNull(); // never armed a wait
    expect(await listWorktrees({ repoPath, worktreeRoot })).toEqual([]);
    expectNoSessionLeak(tmux);
  });

  test("a 'bare-stop' ends 'completed' without parking", async () => {
    const deps = makeDeps({ getAdapter: () => makeAdapterStub({ kind: "bare-stop" }) });
    const id = await start(deps);
    expect(await awaitSettled(id)).toBe("completed");
    expect(getWaitForSignal(db, id)).toBeNull();
  });

  test("a rate-limited classifyStop ends 'rate-limited' and records rate_limit_state", async () => {
    const tmux = makeTmuxStub();
    const resetAt = "2026-05-23T18:00:00Z";
    const deps = makeDeps({
      tmux: tmux.ops,
      getAdapter: () => makeAdapterStub({ kind: "rate-limited", resetAt }),
    });
    const id = await start(deps);

    expect(await awaitSettled(id)).toBe("rate-limited");
    const state = getRateLimitState(db, "stub")!;
    expect(state.status).toBe("RATE_LIMITED");
    expect(state.resetAt).toBe(Date.parse(resetAt));
    expect(await listWorktrees({ repoPath, worktreeRoot })).toEqual([]);
    expectNoSessionLeak(tmux);
  });
});

describe("implementation workflow — asked-question park → answer → resume", () => {
  test("parks on asked-question (waiting-human, answered signal armed, worktree kept), then a signal resumes to completion", async () => {
    const tmux = makeTmuxStub();
    const prompts: string[] = [];
    const postQuestionCalls: Array<{ epicNumber: number; question: string; context?: string }> = [];
    // First drive asks a question; the resumed drive finishes (done).
    // One stub instance shared across drives so its classification sequence
    // advances (initial → asked-question, resume → done).
    const adapter = makeAdapterStub(
      [
        {
          kind: "asked-question",
          sentinelPath: "/x/.middle/blocked.json",
          sentinel: { question: "Option A or B?", context: "Both compile." },
        },
        { kind: "done" },
      ],
      prompts,
    );
    const deps = makeDeps({
      tmux: tmux.ops,
      getAdapter: () => adapter,
      postQuestion: async (opts) => {
        postQuestionCalls.push({
          epicNumber: opts.epicNumber,
          question: opts.question,
          context: opts.context,
        });
      },
    });
    const id = await start(deps);

    // Parked: waiting-human, the epic-scoped 'answered' signal armed, worktree preserved.
    await awaitParked(id);
    expect(getWaitForSignal(db, id)).toEqual({
      signalName: signalNameFor(EPIC, "answered-question"),
      payloadJson: JSON.stringify({ reason: "answered-question" }),
    });
    // The sentinel's question + context are surfaced to the workflow's poster.
    expect(postQuestionCalls).toEqual([
      { epicNumber: EPIC, question: "Option A or B?", context: "Both compile." },
    ]);
    expect((await listWorktrees({ repoPath, worktreeRoot })).length).toBe(1);
    expect(prompts).toEqual(["initial"]); // resume drive not yet run

    // Human reply fires the signal → resume re-drives with the 'answer' prompt.
    await engine.signal(id, RESUME_EVENT, { answer: "use option B" });
    expect(await awaitSettled(id)).toBe("completed");
    expect(prompts).toEqual(["initial", "answer"]);
    expect(getWaitForSignal(db, id)).toBeNull(); // consumed on resume
    expect(await listWorktrees({ repoPath, worktreeRoot })).toEqual([]);
    expectNoSessionLeak(tmux);
  });
});

describe("implementation workflow — done park → review-resolved → resume", () => {
  test("parks on done (waiting-human, review-resolved signal armed), then a signal resumes", async () => {
    const tmux = makeTmuxStub();
    const prompts: string[] = [];
    const adapter = makeAdapterStub([{ kind: "done" }, { kind: "done" }], prompts);
    const deps = makeDeps({ tmux: tmux.ops, getAdapter: () => adapter });
    const id = await start(deps);

    await awaitParked(id);
    expect(getWaitForSignal(db, id)).toEqual({
      signalName: signalNameFor(EPIC, "review-changes"),
      payloadJson: JSON.stringify({ reason: "review-changes" }),
    });
    // No postQuestion for the done/review path.
    expect((await listWorktrees({ repoPath, worktreeRoot })).length).toBe(1);

    await engine.signal(id, RESUME_EVENT, { decision: "CHANGES_REQUESTED" });
    expect(await awaitSettled(id)).toBe("completed");
    expect(prompts).toEqual(["initial", "resume"]); // review-changes resumes with the 'resume' framing
    expect(getWaitForSignal(db, id)).toBeNull();
    expect(await listWorktrees({ repoPath, worktreeRoot })).toEqual([]);
    expectNoSessionLeak(tmux);
  });

  test("a completed resume reverts a previously RATE_LIMITED adapter to AVAILABLE", async () => {
    setRateLimited(db, {
      adapter: "stub",
      resetAt: Date.parse("2026-05-23T18:00:00Z"),
      source: "transcript",
    });
    const adapter = makeAdapterStub([{ kind: "done" }, { kind: "done" }]);
    const deps = makeDeps({ getAdapter: () => adapter });
    const id = await start(deps);
    await awaitParked(id);
    await engine.signal(id, RESUME_EVENT, {});
    expect(await awaitSettled(id)).toBe("completed");
    expect(getRateLimitState(db, "stub")!.status).toBe("AVAILABLE");
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

    const id = await start(deps);
    expect(await awaitSettled(id)).toBe("compensated");
    expect(await listWorktrees({ repoPath, worktreeRoot })).toEqual([]);
    expectNoSessionLeak(tmux);
  });
});
