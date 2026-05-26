import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, HookPayload, StopClassification } from "@middle/core";
import type { IssueComment, PlanCommentReader } from "../src/gates/plan-comment.ts";
import { Engine } from "bunqueue/workflow";
import { openAndMigrate } from "../src/db.ts";
import type { SessionGate } from "../src/hook-server.ts";
import { getRateLimitState, setRateLimited } from "../src/rate-limits.ts";
import { getWaitForSignal, getWorkflow, getWorkflowSource } from "../src/workflow-record.ts";
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

/** A tmux stub that records every session it creates/kills and all sent text. */
function makeTmuxStub() {
  const created: string[] = [];
  const killed: string[] = [];
  const sent: string[] = [];
  return {
    created,
    killed,
    sent,
    ops: {
      async newSession(opts: { sessionName: string }) {
        created.push(opts.sessionName);
      },
      async sendText(_sessionName: string, text: string) {
        sent.push(text);
      },
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
const CI_FAILED = {
  reason: "review-changes" as const,
  outcome: "changes-requested" as const,
  reviewId: null,
  decision: "CI_FAILED",
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

/**
 * Wait for the `workflows` row to reach `state`, regardless of bunqueue exec
 * state. Unlike `awaitParked` (which requires a live `waiting` execution), this
 * also catches `waiting-human` reached via the terminal path — e.g.
 * `nudge-exhausted`, which finalizes the execution but parks the row.
 */
async function awaitRow(id: string, state: string, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getWorkflow(db, id)?.state === state) return;
    await Bun.sleep(15);
  }
  throw new Error(`workflow ${id} did not reach '${state}' (was '${getWorkflow(db, id)?.state}')`);
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
  throw new Error(
    `workflow ${id} did not settle within ${timeoutMs}ms (was '${getWorkflow(db, id)?.state}')`,
  );
}

/** Start a dispatch and wait for it to settle; returns the workflow id. */
async function runToEnd(deps: ImplementationDeps): Promise<string> {
  const id = await start(deps);
  await awaitSettled(id);
  return id;
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

describe("implementation workflow — prepare-worktree survives a step retry (#108)", () => {
  test("a transient createWorktree failure retries to success — the re-INSERT is a no-op, not a masking UNIQUE", async () => {
    // prepare-worktree runs createWorkflowRecord (INSERT) then createWorktree,
    // under bunqueue's default retry: 3. Make createWorktree throw once so the
    // step retries from the top, re-running the INSERT for the same execution id.
    let calls = 0;
    const failingWorktree = {
      async createWorktree(opts: Parameters<typeof createWorktree>[0]) {
        calls += 1;
        if (calls === 1) throw new Error("transient git failure");
        return createWorktree(opts);
      },
      destroyWorktree,
    };
    const tmux = makeTmuxStub();
    const deps = makeDeps({
      tmux: tmux.ops,
      worktree: failingWorktree,
      getAdapter: () => makeAdapterStub({ kind: "bare-stop" }),
    });
    const id = await start(deps);

    // With ON CONFLICT(id) DO NOTHING the retry's createWorkflowRecord no-ops,
    // the second createWorktree succeeds, and the run reaches completed. A plain
    // INSERT would throw `UNIQUE constraint failed: workflows.id` on the retry,
    // masking the transient error and failing the run.
    expect(await awaitSettled(id)).toBe("completed");
    expect(calls).toBe(2); // it actually retried — the retry path was exercised
    expect(getWorkflow(db, id)?.worktreePath).not.toBeNull(); // attempt 2 ran fully
    expectNoSessionLeak(tmux);
  });
});

/** The `.middle/prompt.md` written into the (shared) worktree, by workflow id. */
function readPromptBrief(workflowId: string): string {
  const path = getWorkflow(db, workflowId)?.worktreePath;
  if (!path) throw new Error(`workflow ${workflowId} has no worktree path`);
  return readFileSync(join(path, ".middle", "prompt.md"), "utf8");
}

describe("implementation workflow — complexity pause (#52)", () => {
  test("a complexity-kind pause routes to waiting-human and surfaces with kind 'complexity'", async () => {
    const surfaced: Array<{ kind: string; question: string }> = [];
    const deps = makeDeps({
      getAdapter: () =>
        makeAdapterStub({
          kind: "asked-question",
          sentinelPath: "/x/.middle/blocked.json",
          sentinel: {
            question: "4 viable persistence designs, no clear winner",
            context: "A/B/C/D all plausible",
            kind: "complexity",
          },
        }),
      postQuestion: async (opts) => {
        surfaced.push({ kind: opts.kind, question: opts.question });
      },
    });
    const id = await start(deps);
    await awaitParked(id); // asserts the row reads waiting-human
    expect(surfaced).toEqual([
      { kind: "complexity", question: "4 viable persistence designs, no clear winner" },
    ]);
  });

  test("a plain question pause surfaces with kind 'question' (the default)", async () => {
    const surfaced: Array<{ kind: string }> = [];
    const deps = makeDeps({
      getAdapter: () =>
        makeAdapterStub({
          kind: "asked-question",
          sentinelPath: "/x/.middle/blocked.json",
          sentinel: { question: "Which API base URL?" }, // no kind → question
        }),
      postQuestion: async (opts) => {
        surfaced.push({ kind: opts.kind });
      },
    });
    const id = await start(deps);
    await awaitParked(id);
    expect(surfaced).toEqual([{ kind: "question" }]);
  });

  test("the dispatch brief carries the repo's complexity_ceiling as the agent's fork budget", async () => {
    const deps = makeDeps({
      resolveComplexityCeiling: () => 5,
      getAdapter: () =>
        makeAdapterStub({
          kind: "asked-question",
          sentinelPath: "/x/.middle/blocked.json",
          sentinel: { question: "park to keep the worktree" },
        }),
      postQuestion: async () => {},
    });
    const id = await start(deps);
    await awaitParked(id); // waiting-human keeps the worktree so the brief is readable
    const brief = readPromptBrief(id);
    expect(brief).toContain("more than 5 candidate forks");
    // Not approved by default → the brief tells the agent to pause, not push past.
    expect(brief).toContain('"kind": "complexity"');
    expect(brief).not.toContain("approved");
  });

  test("an in-ceiling decision never surfaces a complexity pause", async () => {
    // No complexity sentinel: the agent resolved its decisions within the ceiling.
    // A `done` parks for *review* (waiting-human), which is NOT a complexity pause —
    // the only thing that surfaces a pause is an asked-question stop, and this isn't
    // one, so postQuestion is never called.
    let surfaced = false;
    const deps = makeDeps({
      getAdapter: () => makeAdapterStub({ kind: "done" }),
      postQuestion: async () => {
        surfaced = true;
      },
    });
    const id = await start(deps);
    await awaitRow(id, "waiting-human"); // the review park
    // Give any stray surface call a chance to land before asserting it didn't.
    await Bun.sleep(50);
    expect(surfaced).toBe(false);
  });

  test("an approved Epic's brief authorizes proceeding past a complexity overrun (#53)", async () => {
    const deps = makeDeps({
      isEpicApproved: () => true,
      resolveComplexityCeiling: () => 3,
      getAdapter: () =>
        makeAdapterStub({
          kind: "asked-question",
          sentinelPath: "/x/.middle/blocked.json",
          sentinel: { question: "park to keep the worktree" },
        }),
      postQuestion: async () => {},
    });
    const id = await start(deps);
    await awaitParked(id);
    const brief = readPromptBrief(id);
    // Approved → proceed past, do not pause.
    expect(brief).toContain("`approved` label");
    expect(brief).toContain("do NOT pause");
    expect(brief).toContain("best-judgment call");
  });

  test("a flaky brief-context read falls back to safe defaults, never failing the dispatch", async () => {
    const deps = makeDeps({
      resolveComplexityCeiling: () => {
        throw new Error("gh rate limited");
      },
      isEpicApproved: () => {
        throw new Error("gh rate limited");
      },
      getAdapter: () =>
        makeAdapterStub({
          kind: "asked-question",
          sentinelPath: "/x/.middle/blocked.json",
          sentinel: { question: "park" },
        }),
      postQuestion: async () => {},
    });
    const id = await start(deps);
    await awaitParked(id); // parked, not failed — the throw didn't abort the drive
    const brief = readPromptBrief(id);
    expect(brief).toContain("more than 3 candidate forks"); // default ceiling
    expect(brief).not.toContain("`approved` label"); // default: not approved
  });
});

describe("implementation workflow — dispatch source (#53)", () => {
  test("records source 'manual' for a manual dispatch and 'auto' by default", async () => {
    const manualDeps = makeDeps({
      getAdapter: () =>
        makeAdapterStub({
          kind: "asked-question",
          sentinelPath: "/x/.middle/blocked.json",
          sentinel: { question: "park" },
        }),
      postQuestion: async () => {},
    });
    engine.register(createImplementationWorkflow(manualDeps));
    const manual = await engine.start("implementation", { ...INPUT, source: "manual" as const });
    await awaitParked(manual.id);
    expect(getWorkflowSource(db, manual.id)).toBe("manual");

    // A fresh dispatch with no source defaults to 'auto'.
    const auto = await engine.start("implementation", { ...INPUT, epicNumber: 99 });
    await awaitParked(auto.id);
    expect(getWorkflowSource(db, auto.id)).toBe("auto");
  });
});

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
    const { deps, continuationIds } = withContinuations({
      tmux: tmux.ops,
      getAdapter: () => adapter,
    });
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

  test("a CI_FAILED verdict resumes a continuation with the fix-CI brief (not the address-review one)", async () => {
    const prompts: string[] = [];
    const adapter = makeAdapterStub({ kind: "done" }, prompts);
    const { deps, continuationIds } = withContinuations({ getAdapter: () => adapter });
    const id0 = await start(deps);
    await awaitParked(id0);

    // Red CI (no review feedback) resumes the agent to fix the build.
    await engine.signal(id0, RESUME_EVENT, CI_FAILED);
    expect(await awaitSettled(id0)).toBe("completed");

    const id1 = await awaitContinuation(continuationIds, 0);
    await awaitParked(id1);
    const brief = readPromptBrief(id1);
    expect(brief).toContain("CI is failing — round 1 of 5");
    expect(brief).toContain("gh pr checks");
    expect(brief).toContain("Push once");
    // It is NOT the address-review brief — there are no review threads to work.
    expect(brief).not.toContain("Addressing review feedback");

    await engine.signal(id1, RESUME_EVENT, APPROVED);
    expect(await awaitSettled(id1)).toBe("completed");
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
    let settledState: string | undefined;
    while (Date.now() < deadline) {
      settledState = engine.getExecution(id2)?.state;
      if (settledState === "completed" || settledState === "failed") break;
      await Bun.sleep(15);
    }
    // Fail fast: if the cap path never ran resume-or-finalize to settle, the
    // assertions below could still pass off the park-time `waiting-human` state
    // and mask the regression. Require the execution to have actually settled.
    expect(settledState === "completed" || settledState === "failed").toBe(true);
    // Capped: parks in waiting-human, no continuation enqueued, no armed wait
    // (poller stops watching), worktree preserved for the human.
    expect(getWorkflow(db, id2)?.state).toBe("waiting-human");
    expect(continuationIds).toHaveLength(2); // id1, id2 — no third round
    expect(getWaitForSignal(db, id2)).toBeNull(); // consumed, not re-armed
    expect((await listWorktrees({ repoPath, worktreeRoot })).length).toBe(1);
  });
});

/** A worktree stub that materializes a temp dir and (optionally) writes a plan.md. */
function makeWorktreeStub(planBody: string | null) {
  const handles: { path: string }[] = [];
  return {
    handles,
    ops: {
      async createWorktree(opts: { repoPath: string; repo: string; issueNumber?: number }) {
        const path = realpathSync(mkdtempSync(join(tmpdir(), "middle-wt-stub-")));
        if (planBody !== null) {
          const dir = join(path, "planning", "issues", String(opts.issueNumber));
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "plan.md"), planBody);
        }
        const handle = {
          repoPath: opts.repoPath,
          path,
          branch: "stub-branch",
          repo: opts.repo,
          unit: `issue-${opts.issueNumber}`,
        };
        handles.push(handle);
        return handle;
      },
      async destroyWorktree(handle: { path: string }) {
        rmSync(handle.path, { recursive: true, force: true });
      },
    },
  };
}

/** A PlanCommentReader stub returning fixed comments on the Epic. */
function makePlanReader(comments: IssueComment[]): PlanCommentReader {
  return {
    async listIssueComments() {
      return comments;
    },
  };
}

describe("implementation workflow — plan-comment completion gate", () => {
  const PLAN = "# Plan\n\nphases: do the thing\n";

  test("a 'done' drive with no plan comment ends 'failed' (guard fires)", async () => {
    const tmux = makeTmuxStub();
    const wt = makeWorktreeStub(PLAN);
    const deps = makeDeps({
      tmux: tmux.ops,
      worktree: wt.ops,
      getAdapter: () => makeAdapterStub({ kind: "done" }),
      planCommentReader: makePlanReader([
        { authorLogin: "agentbot", body: "no plan here", url: "u" },
      ]),
      agentLogin: "agentbot",
    });
    const id = await runToEnd(deps);

    expect(getWorkflow(db, id)!.state).toBe("failed");
    expectNoSessionLeak(tmux);
  });

  test("a 'done' with a matching plan comment passes the guard and parks for review", async () => {
    const tmux = makeTmuxStub();
    const wt = makeWorktreeStub(PLAN);
    const deps = makeDeps({
      tmux: tmux.ops,
      worktree: wt.ops,
      getAdapter: () => makeAdapterStub({ kind: "done" }),
      planCommentReader: makePlanReader([{ authorLogin: "agentbot", body: PLAN, url: "u" }]),
      agentLogin: "agentbot",
    });
    const id = await start(deps);

    // Guard passed (not demoted to failed) → `done` parks on review-resolved.
    await awaitRow(id, "waiting-human");
    expectNoSessionLeak(tmux);
  });

  test("without a planCommentReader wired, a 'done' parks unguarded (back-compat)", async () => {
    const deps = makeDeps({ getAdapter: () => makeAdapterStub({ kind: "done" }) });
    const id = await start(deps);
    await awaitRow(id, "waiting-human");
  });
});

describe("implementation workflow — positive done-signal (bare-stop nudge loop)", () => {
  test("a bare-stop with no ready Epic PR nudges, then parks in waiting-human", async () => {
    const tmux = makeTmuxStub();
    const deps = makeDeps({
      tmux: tmux.ops,
      getAdapter: () => makeAdapterStub({ kind: "bare-stop" }),
      epicPrReadiness: async () => ({ exists: false, isDraft: false }),
      maxNudges: 2,
    });
    const id = await start(deps);

    // nudge-exhausted parks the row in waiting-human (via the terminal path).
    await awaitRow(id, "waiting-human");
    // nudged exactly maxNudges times before giving up
    expect(tmux.sent.filter((t) => t === "continue").length).toBe(2);
    expectNoSessionLeak(tmux);
  });

  test("a ready, non-draft Epic PR is the positive done-signal — done (no nudge), parks for review", async () => {
    const tmux = makeTmuxStub();
    const deps = makeDeps({
      tmux: tmux.ops,
      getAdapter: () => makeAdapterStub({ kind: "bare-stop" }),
      epicPrReadiness: async () => ({ exists: true, isDraft: false }),
      maxNudges: 2,
    });
    const id = await start(deps);

    await awaitRow(id, "waiting-human");
    expect(tmux.sent.filter((t) => t === "continue").length).toBe(0);
  });

  test("a draft Epic PR is not a positive done-signal — it still nudges", async () => {
    const tmux = makeTmuxStub();
    const deps = makeDeps({
      tmux: tmux.ops,
      getAdapter: () => makeAdapterStub({ kind: "bare-stop" }),
      epicPrReadiness: async () => ({ exists: true, isDraft: true }),
      maxNudges: 1,
    });
    const id = await start(deps);

    await awaitRow(id, "waiting-human");
    expect(tmux.sent.filter((t) => t === "continue").length).toBe(1);
  });

  test("without an epicPrReadiness seam, a bare-stop keeps the legacy completion (back-compat)", async () => {
    const tmux = makeTmuxStub();
    const deps = makeDeps({
      tmux: tmux.ops,
      getAdapter: () => makeAdapterStub({ kind: "bare-stop" }),
    });
    const id = await runToEnd(deps);

    expect(getWorkflow(db, id)!.state).toBe("completed");
    expect(tmux.sent.filter((t) => t === "continue").length).toBe(0);
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

describe("implementation workflow — verify-on-stop gate", () => {
  test("a `done` whose verify fails then passes nudges in-session, then parks for review", async () => {
    const tmux = makeTmuxStub();
    let verifyCalls = 0;
    const deps = makeDeps({
      tmux: tmux.ops,
      getAdapter: () => makeAdapterStub({ kind: "done" }),
      runVerifyGates: async () => {
        verifyCalls += 1;
        return verifyCalls === 1
          ? { ok: false, report: "### gate `lint` failed (exit 1)\nunused import" }
          : { ok: true, report: "" };
      },
    });
    const id = await start(deps);
    await awaitParked(id); // verified `done` → parks for review (waiting-human, signal armed)
    expect(verifyCalls).toBe(2); // failed once, re-ran after the in-session fix, passed
    expect(tmux.sent.some((t) => t.includes("verification gates are failing"))).toBe(true);
  });

  test("a `done` whose verify never passes parks for a human and keeps the worktree", async () => {
    const tmux = makeTmuxStub();
    let verifyCalls = 0;
    const deps = makeDeps({
      tmux: tmux.ops,
      getAdapter: () => makeAdapterStub({ kind: "done" }),
      verifyRoundCap: 1,
      runVerifyGates: async () => {
        verifyCalls += 1;
        return { ok: false, report: "still broken" };
      },
    });
    const id = await start(deps);
    await awaitRow(id, "waiting-human"); // exhausted → parks for a human (terminal path)
    expect(verifyCalls).toBe(2); // round 0 fails → nudge → round 1 hits the cap
    // Terminal, not a review park: `nudge-exhausted` is not a park kind, so no
    // resume signal is armed (a reused-park `waiting-human` would arm one).
    expect(getWaitForSignal(db, id)).toBeNull();
    // The PR never shipped unverified, and the worktree is kept for the human.
    expect((await listWorktrees({ repoPath, worktreeRoot })).length).toBe(1);
    expectNoSessionLeak(tmux);
  });

  test("a verify re-stop classified `bare-stop` can't bypass the done-signal", async () => {
    // The fix nudge's re-stop classifies as a bare-stop (not `done`). With a
    // readiness seam wired and no ready PR, that bare-stop must NOT complete as
    // legacy — it routes through the #80 done-signal check and, exhausting the
    // bare-stop nudge budget, parks for a human instead of shipping.
    const tmux = makeTmuxStub();
    let verifyCalls = 0;
    const deps = makeDeps({
      tmux: tmux.ops,
      maxNudges: 0, // a bare-stop with no ready PR parks immediately
      // First stop is `done` (enters verify); every later re-stop is a bare-stop.
      getAdapter: () => makeAdapterStub([{ kind: "done" }, { kind: "bare-stop" }]),
      epicPrReadiness: async () => ({ exists: false, isDraft: false }),
      runVerifyGates: async () => {
        verifyCalls += 1;
        return { ok: false, report: "still broken" };
      },
    });
    const id = await start(deps);
    await awaitRow(id, "waiting-human"); // bare-stop with no ready PR → parks, not completed
    expect(verifyCalls).toBe(1); // failed once → nudge → re-stop routed to resolveBareStop
    expect(getWaitForSignal(db, id)).toBeNull(); // nudge-exhausted is terminal
    expect((await listWorktrees({ repoPath, worktreeRoot })).length).toBe(1);
    expectNoSessionLeak(tmux);
  });

  test("no runVerifyGates seam → a `done` parks for review unchanged (verify is opt-in)", async () => {
    const deps = makeDeps({ getAdapter: () => makeAdapterStub({ kind: "done" }) });
    const id = await start(deps);
    await awaitParked(id); // unaffected when the seam is absent
  });
});
