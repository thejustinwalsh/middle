/**
 * Integration (#253): the booted poller cron escalates a long-parked Epic on the
 * real path and **preserves** its worktree. A real github-mode dispatch drives to
 * a `waiting-human` park with a real worktree on disk; the park's arm time is
 * backdated past the staleness threshold; the poller cron's park-escalation pass
 * then posts an escalation comment on the Epic (via the test `gh` seam) AND leaves
 * the worktree untouched — no compensate handler ran, so branch/plan/decisions
 * survive.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "bunqueue/workflow";
import type { AgentAdapter, HookPayload, StopClassification } from "@middle/core";
import { openAndMigrate } from "../src/db.ts";
import type { SessionGate } from "../src/hook-server.ts";
import type {
  EpicPrLifecycle,
  PollGateway,
  PrSnapshot,
  RateLimitStatus,
} from "../src/poller.ts";
import { startPoller } from "../src/poller-cron.ts";
import { DEFAULT_PARK_STALENESS_MS, PARK_ESCALATED_EVENT } from "../src/park-escalation.ts";
import { getWorkflow, hasEventOfType } from "../src/workflow-record.ts";
import {
  createImplementationWorkflow,
  RESUME_EVENT,
  type ImplementationDeps,
} from "../src/workflows/implementation.ts";
import { createWorktree, destroyWorktree } from "../src/worktree.ts";
import type { Database } from "bun:sqlite";

const REPO = "thejustinwalsh/middle";
const EPIC_REF = "777";
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@e.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@e.invalid",
};
async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "ignore",
    stderr: "pipe",
    env: GIT_ENV,
  });
  if ((await proc.exited) !== 0)
    throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
}

let scratch: string;
let repoPath: string;
let worktreeRoot: string;
let db: Database;
let engine: Engine;

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "middle-park-int-")));
  repoPath = join(scratch, "repo");
  worktreeRoot = join(scratch, "worktrees");
  await git(scratch, ["init", "repo"]);
  await git(repoPath, ["commit", "--allow-empty", "-m", "init"]);
  db = openAndMigrate(join(scratch, "db.sqlite3"));
  engine = new Engine({ embedded: true });
});

afterEach(async () => {
  await engine.close(true);
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** A gate whose Stop wait never resolves — the park is reached via session-ended. */
const hangingGate: SessionGate = {
  awaitSessionStart: async () =>
    ({ session_id: "stub", transcript_path: "/tmp/stub.jsonl" }) as HookPayload,
  awaitStop: () => new Promise<HookPayload>(() => {}),
};

/** An adapter that writes a real `.middle/blocked.json` and asks a question. */
function makeAdapter(): AgentAdapter {
  const seq: StopClassification[] = [
    {
      kind: "asked-question",
      sentinelPath: "/x/.middle/blocked.json",
      sentinel: { question: "A or B?" },
    },
    { kind: "bare-stop" },
  ];
  let i = 0;
  return {
    name: "stub",
    readyEvent: "session.started",
    async installHooks(opts) {
      mkdirSync(join(opts.worktree, ".middle"), { recursive: true });
      writeFileSync(join(opts.worktree, ".middle", "blocked.json"), JSON.stringify({ question: "?" }));
    },
    buildLaunchCommand: () => ({ argv: ["true"], env: {} }),
    buildPromptText: () => "@.middle/prompt.md",
    async enterAutoMode() {},
    resolveTranscriptPath: (p) => p.transcript_path as string,
    readTranscriptState: () => ({
      lastActivity: "",
      contextTokens: 0,
      turnCount: 0,
      lastToolUse: null,
    }),
    classifyStop: () => seq[Math.min(i++, seq.length - 1)]!,
  };
}

/** A github poll gateway that surfaces no resume + a healthy rate-limit budget. */
const stubGithubPoll: PollGateway = {
  async listIssueComments() {
    return [];
  },
  async findPrForEpic(): Promise<PrSnapshot | null> {
    return null;
  },
  async findEpicPrLifecycle(): Promise<EpicPrLifecycle | null> {
    return null;
  },
  async prSnapshot(): Promise<PrSnapshot | null> {
    return null;
  },
  async prLifecycle(): Promise<EpicPrLifecycle | null> {
    return null;
  },
  async getRateLimit(): Promise<RateLimitStatus> {
    return { remaining: 5000, resetAt: 0 };
  },
};

function makeDeps(postQuestion: ImplementationDeps["postQuestion"]): ImplementationDeps {
  return {
    db,
    getAdapter: () => makeAdapter(),
    sessionGate: hangingGate,
    tmux: {
      async newSession() {},
      async sendText() {},
      async sendEnter() {},
      async killSession() {},
      status: async () => ({ alive: false }),
    },
    worktree: { createWorktree, destroyWorktree },
    resolveRepoPath: () => repoPath,
    worktreeRoot,
    dispatcherUrl: "http://127.0.0.1:8822",
    launchTimeoutMs: 2000,
    stopTimeoutMs: 2000,
    livenessPollMs: 20,
    enqueueContinuation: async (input) => {
      await engine.start("implementation", input);
    },
    postQuestion,
  };
}

async function awaitState(id: string, state: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getWorkflow(db, id)?.state === state) return;
    await Bun.sleep(20);
  }
  throw new Error(`workflow ${id} did not reach '${state}' (was '${getWorkflow(db, id)?.state}')`);
}

async function awaitEscalated(id: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasEventOfType(db, id, PARK_ESCALATED_EVENT)) return;
    await Bun.sleep(20);
  }
  throw new Error(`workflow ${id} was not escalated within ${timeoutMs}ms`);
}

describe("park-escalation integration (#253)", () => {
  test("the booted poller escalates a stale park on the Epic and preserves the worktree", async () => {
    const questions: unknown[] = [];
    engine.register(createImplementationWorkflow(makeDeps(async (q) => void questions.push(q))));
    const handle = await engine.start("implementation", {
      repo: REPO,
      epicRef: EPIC_REF,
      adapter: "stub",
    });

    // A real drive parks waiting-human with a real worktree on disk.
    await awaitState(handle.id, "waiting-human");
    const worktreePath = getWorkflow(db, handle.id)!.worktreePath!;
    expect(worktreePath).toBeTruthy();
    expect(existsSync(worktreePath)).toBe(true);
    // The park asked a question (so the answered-question wait is armed).
    expect(questions.length).toBe(1);

    // Backdate the armed wait past the staleness threshold so real `now` reads it
    // as stale — driving the real escalation path without sleeping 7 days.
    const staleArm = Date.now() - DEFAULT_PARK_STALENESS_MS - 24 * 60 * 60 * 1000;
    db.run("UPDATE waitfor_signals SET created_at = ? WHERE workflow_id = ?", [
      staleArm,
      handle.id,
    ]);

    const posted: Array<{ repo: string; epicRef: string; body: string }> = [];
    const stop = await startPoller(
      {
        db,
        github: stubGithubPoll,
        fireSignal: (id, payload) => engine.signal(id, RESUME_EVENT, payload),
        // The test `gh` seam — both the resume poller and the escalation pass use it.
        postEpicComment: async (repo, epicRef, body) => void posted.push({ repo, epicRef, body }),
      },
      { intervalMs: 40 },
    );
    try {
      // The escalation pass fires on a tick: comment dispatched + event recorded.
      await awaitEscalated(handle.id);

      // (1) An escalation comment was dispatched to the Epic via the gh seam.
      const escalation = posted.find((p) => p.epicRef === EPIC_REF);
      expect(escalation).toBeDefined();
      expect(escalation!.repo).toBe(REPO);
      expect(escalation!.body).toContain("parked for");

      // (2) The worktree is STILL on disk — no compensate handler ran.
      expect(existsSync(worktreePath)).toBe(true);
      // (3) The row is still parked (not compensated/destroyed).
      expect(getWorkflow(db, handle.id)!.state).toBe("waiting-human");
    } finally {
      await stop();
    }
  });
});
