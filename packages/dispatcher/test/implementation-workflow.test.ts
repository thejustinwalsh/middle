import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, HookPayload, StopClassification } from "@middle/core";
import type { IssueComment, PlanCommentReader } from "../src/gates/plan-comment.ts";
import { Engine } from "bunqueue/workflow";
import { openAndMigrate } from "../src/db.ts";
import type { SessionGate } from "../src/hook-server.ts";
import { getRateLimitState, setRateLimited } from "../src/rate-limits.ts";
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
    expect(record.sessionName).toBe("middle-thejustinwalsh-middle-6");
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

describe("implementation workflow — rate-limit state", () => {
  test("a rate-limited classifyStop ends 'rate-limited' and records rate_limit_state", async () => {
    const tmux = makeTmuxStub();
    const resetAt = "2026-05-23T18:00:00Z";
    const deps = makeDeps({
      tmux: tmux.ops,
      getAdapter: () => makeAdapterStub({ kind: "rate-limited", resetAt }),
    });
    const id = await runToEnd(deps);

    expect(getWorkflow(db, id)!.state).toBe("rate-limited");
    const state = getRateLimitState(db, "stub")!;
    expect(state.status).toBe("RATE_LIMITED");
    expect(state.resetAt).toBe(Date.parse(resetAt));
    expect(state.source).toBe("transcript");
    // worktree + session still cleaned up
    expect(await listWorktrees({ repoPath, worktreeRoot })).toEqual([]);
    expectNoSessionLeak(tmux);
  });

  test("a completed dispatch reverts a previously RATE_LIMITED adapter to AVAILABLE", async () => {
    setRateLimited(db, { adapter: "stub", resetAt: Date.parse("2026-05-23T18:00:00Z"), source: "transcript" });
    const deps = makeDeps({ getAdapter: () => makeAdapterStub({ kind: "done" }) });
    const id = await runToEnd(deps);

    expect(getWorkflow(db, id)!.state).toBe("completed");
    expect(getRateLimitState(db, "stub")!.status).toBe("AVAILABLE");
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
  return { async listIssueComments() { return comments; } };
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
      planCommentReader: makePlanReader([{ authorLogin: "agentbot", body: "no plan here", url: "u" }]),
      agentLogin: "agentbot",
    });
    const id = await runToEnd(deps);

    expect(getWorkflow(db, id)!.state).toBe("failed");
    expectNoSessionLeak(tmux);
  });

  test("a 'done' drive with a matching plan comment completes", async () => {
    const tmux = makeTmuxStub();
    const wt = makeWorktreeStub(PLAN);
    const deps = makeDeps({
      tmux: tmux.ops,
      worktree: wt.ops,
      getAdapter: () => makeAdapterStub({ kind: "done" }),
      planCommentReader: makePlanReader([{ authorLogin: "agentbot", body: PLAN, url: "u" }]),
      agentLogin: "agentbot",
    });
    const id = await runToEnd(deps);

    expect(getWorkflow(db, id)!.state).toBe("completed");
    expectNoSessionLeak(tmux);
  });

  test("without a planCommentReader wired, completion is unguarded (back-compat)", async () => {
    const deps = makeDeps({ getAdapter: () => makeAdapterStub({ kind: "done" }) });
    const id = await runToEnd(deps);
    expect(getWorkflow(db, id)!.state).toBe("completed");
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
    const id = await runToEnd(deps);

    expect(getWorkflow(db, id)!.state).toBe("waiting-human");
    // nudged exactly maxNudges times before giving up
    expect(tmux.sent.filter((t) => t === "continue").length).toBe(2);
    expectNoSessionLeak(tmux);
  });

  test("a bare-stop completes once a ready, non-draft Epic PR exists (no nudge)", async () => {
    const tmux = makeTmuxStub();
    const deps = makeDeps({
      tmux: tmux.ops,
      getAdapter: () => makeAdapterStub({ kind: "bare-stop" }),
      epicPrReadiness: async () => ({ exists: true, isDraft: false }),
      maxNudges: 2,
    });
    const id = await runToEnd(deps);

    expect(getWorkflow(db, id)!.state).toBe("completed");
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
    const id = await runToEnd(deps);

    expect(getWorkflow(db, id)!.state).toBe("waiting-human");
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
