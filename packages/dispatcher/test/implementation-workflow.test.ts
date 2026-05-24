import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
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
    // Default: no continuation expected. Tests exercising the re-enqueue loop
    // override this with the engine-backed harness below.
    enqueueContinuation: async () => {
      throw new Error("unexpected continuation enqueue");
    },
    ...overrides,
  };
}

/**
 * Wire `enqueueContinuation` to the test engine so a resume actually starts the
 * next round as a fresh execution, recording each continuation's id. This is
 * the production seam (`engine.start("implementation", input)`) under test —
 * the re-enqueue loop the spec annotates `// loop back via re-enqueue`.
 */
function withContinuations(overrides: Partial<ImplementationDeps>): {
  deps: ImplementationDeps;
  continuationIds: string[];
} {
  const continuationIds: string[] = [];
  const deps = makeDeps({
    ...overrides,
    enqueueContinuation: async (input) => {
      const handle = await engine.start("implementation", input);
      continuationIds.push(handle.id);
    },
  });
  return { deps, continuationIds };
}

/** Wait until the indexed continuation has been enqueued, returning its id. */
async function awaitContinuation(ids: string[], index: number, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ids[index]) return ids[index]!;
    await Bun.sleep(15);
  }
  throw new Error(`continuation #${index} was not enqueued within ${timeoutMs}ms`);
}

const CHANGES_REQUESTED = {
  reason: "review-changes" as const,
  outcome: "changes-requested" as const,
  reviewId: 1,
  decision: "CHANGES_REQUESTED",
};
const APPROVED = {
  reason: "review-changes" as const,
  outcome: "resolved" as const,
  reviewId: 2,
  decision: "APPROVED",
};

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

/** The `.middle/prompt.md` written into the (shared) worktree, by workflow id. */
function readPromptBrief(workflowId: string): string {
  const path = getWorkflow(db, workflowId)?.worktreePath;
  if (!path) throw new Error(`workflow ${workflowId} has no worktree path`);
  return readFileSync(join(path, ".middle", "prompt.md"), "utf8");
}

describe("implementation workflow — asked-question park → answer → resume (e2e)", () => {
  test("parks on asked-question, a human reply resumes a fresh continuation with the answer injected", async () => {
    const tmux = makeTmuxStub();
    const prompts: string[] = [];
    const postQuestionCalls: Array<{ epicNumber: number; question: string; context?: string }> = [];
    // One shared stub instance so its classification sequence advances across
    // both executions: initial → asked-question, the continuation → done.
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
    const { deps, continuationIds } = withContinuations({
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
    const id0 = await start(deps);

    // Parked: waiting-human, the epic-scoped 'answered' signal armed, worktree kept.
    await awaitParked(id0);
    expect(getWaitForSignal(db, id0)).toEqual({
      signalName: signalNameFor(EPIC, "answered-question"),
      payloadJson: JSON.stringify({ reason: "answered-question" }),
    });
    expect(postQuestionCalls).toEqual([
      { epicNumber: EPIC, question: "Option A or B?", context: "Both compile." },
    ]);
    expect((await listWorktrees({ repoPath, worktreeRoot })).length).toBe(1);
    expect(prompts).toEqual(["initial"]); // continuation not yet driven

    // The poller fires the human's reply → a fresh continuation execution.
    await engine.signal(id0, RESUME_EVENT, {
      reason: "answered-question",
      reply: { commentId: 7, authorLogin: "alice", body: "Use option B." },
    });
    // The original execution hands off and ends; its wait is consumed.
    expect(await awaitSettled(id0)).toBe("completed");
    expect(getWaitForSignal(db, id0)).toBeNull();

    // The continuation re-drives with the 'answer' prompt, reusing the worktree,
    // and the human's reply is injected into its brief.
    const id1 = await awaitContinuation(continuationIds, 0);
    await awaitParked(id1); // the answered continuation reaches done → parks on review
    expect(prompts).toEqual(["initial", "answer"]);
    expect(getWorkflow(db, id1)?.worktreePath).toBe(getWorkflow(db, id0)?.worktreePath);
    const brief = readPromptBrief(id1);
    expect(brief).toContain("a human answered");
    expect(brief).toContain("Use option B.");
    expect(brief).toContain("@alice");
    // An answered question does not advance the review counter; it parks on review.
    expect(getWaitForSignal(db, id1)).toEqual({
      signalName: signalNameFor(EPIC, "review-changes"),
      payloadJson: JSON.stringify({ reason: "review-changes" }),
    });

    // Approve to end the loop cleanly and prove the worktree is torn down once.
    await engine.signal(id1, RESUME_EVENT, APPROVED);
    expect(await awaitSettled(id1)).toBe("completed");
    expect(await listWorktrees({ repoPath, worktreeRoot })).toEqual([]);
    expectNoSessionLeak(tmux);
  });
});

describe("implementation workflow — done park → review-changes → resume (e2e)", () => {
  test("a CHANGES_REQUESTED pass resumes a continuation with the address-review brief; APPROVED ends the loop", async () => {
    const tmux = makeTmuxStub();
    const prompts: string[] = [];
    const adapter = makeAdapterStub({ kind: "done" }, prompts);
    const { deps, continuationIds } = withContinuations({ tmux: tmux.ops, getAdapter: () => adapter });
    const id0 = await start(deps);

    await awaitParked(id0);
    expect(getWaitForSignal(db, id0)).toEqual({
      signalName: signalNameFor(EPIC, "review-changes"),
      payloadJson: JSON.stringify({ reason: "review-changes" }),
    });
    expect((await listWorktrees({ repoPath, worktreeRoot })).length).toBe(1);

    // A reviewer requests changes → resume a continuation to address them.
    await engine.signal(id0, RESUME_EVENT, CHANGES_REQUESTED);
    expect(await awaitSettled(id0)).toBe("completed");

    const id1 = await awaitContinuation(continuationIds, 0);
    await awaitParked(id1);
    // Resumes with the 'resume' framing; the brief is the address-review brief
    // (round 1 of the default cap 5) that points at the skill's procedure.
    expect(prompts).toEqual(["initial", "resume"]);
    const brief = readPromptBrief(id1);
    expect(brief).toContain("address review — round 1 of 5");
    expect(brief).toContain("Addressing review feedback");
    expect(brief).toContain("Push once");
    expect(brief).toContain("CHANGES_REQUESTED");

    // The agent re-requested review; an APPROVED verdict ends the loop (terminal).
    await engine.signal(id1, RESUME_EVENT, APPROVED);
    expect(await awaitSettled(id1)).toBe("completed");
    expect(continuationIds).toHaveLength(1); // no further round after APPROVED
    expect(getWaitForSignal(db, id1)).toBeNull();
    expect(await listWorktrees({ repoPath, worktreeRoot })).toEqual([]);
    expectNoSessionLeak(tmux);
  });

  test("a resolved review reverts a previously RATE_LIMITED adapter to AVAILABLE", async () => {
    setRateLimited(db, {
      adapter: "stub",
      resetAt: Date.parse("2026-05-23T18:00:00Z"),
      source: "transcript",
    });
    const { deps } = withContinuations({ getAdapter: () => makeAdapterStub({ kind: "done" }) });
    const id = await start(deps);
    await awaitParked(id);
    await engine.signal(id, RESUME_EVENT, APPROVED);
    expect(await awaitSettled(id)).toBe("completed");
    expect(getRateLimitState(db, "stub")!.status).toBe("AVAILABLE");
  });
});

describe("implementation workflow — review-round cap", () => {
  test("after the configured cap of CHANGES_REQUESTED passes without APPROVED, it parks in waiting-human and stops auto-resuming", async () => {
    const tmux = makeTmuxStub();
    const adapter = makeAdapterStub({ kind: "done" });
    // Cap of 2: rounds 1 and 2 re-enqueue; the 3rd CHANGES_REQUESTED caps.
    const { deps, continuationIds } = withContinuations({
      tmux: tmux.ops,
      getAdapter: () => adapter,
      reviewRoundCap: 2,
    });
    const id0 = await start(deps);

    // Round 0 (initial) parks; request changes → round 1.
    await awaitParked(id0);
    await engine.signal(id0, RESUME_EVENT, CHANGES_REQUESTED);
    expect(await awaitSettled(id0)).toBe("completed");

    // Round 1 parks; request changes → round 2.
    const id1 = await awaitContinuation(continuationIds, 0);
    await awaitParked(id1);
    expect(readPromptBrief(id1)).toContain("round 1 of 2");
    await engine.signal(id1, RESUME_EVENT, CHANGES_REQUESTED);
    expect(await awaitSettled(id1)).toBe("completed");

    // Round 2 parks; request changes again → would be round 3 > cap → capped.
    const id2 = await awaitContinuation(continuationIds, 1);
    await awaitParked(id2);
    expect(readPromptBrief(id2)).toContain("round 2 of 2");
    await engine.signal(id2, RESUME_EVENT, CHANGES_REQUESTED);

    // Both "parked" and "capped" read as `waiting-human`, so wait on the
    // definitive barrier: the bunqueue execution fully settling (the cap path
    // runs `resume-or-finalize` to completion, which consumes id2's armed wait).
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const s = engine.getExecution(id2)?.state;
      if (s === "completed" || s === "failed") break;
      await Bun.sleep(15);
    }
    // Capped: parks in waiting-human, no continuation enqueued, no armed wait
    // (poller stops watching), worktree preserved for the human.
    expect(getWorkflow(db, id2)?.state).toBe("waiting-human");
    expect(continuationIds).toHaveLength(2); // id1, id2 — no third round
    expect(getWaitForSignal(db, id2)).toBeNull(); // consumed, not re-armed
    expect((await listWorktrees({ repoPath, worktreeRoot })).length).toBe(1);
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
