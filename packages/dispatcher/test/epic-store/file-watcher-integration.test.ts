/**
 * Integration (#197): the Phase-2 file-watcher resumes a parked file-mode Epic.
 * A real file-mode dispatch parks asking a question (`waiting-human`); a human
 * edits the Epic file's `<!-- middle:answer -->` block to non-empty content; the
 * poller cron's file-watcher pass detects the mtime change on the next tick, fires
 * the resume signal, and the continuation drives to `completed`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "bunqueue/workflow";
import type { AgentAdapter, HookPayload, StopClassification } from "@middle/core";
import { openAndMigrate } from "../../src/db.ts";
import type { SessionGate } from "../../src/hook-server.ts";
import type {
  EpicPrLifecycle,
  PollGateway,
  PrSnapshot,
  RateLimitStatus,
} from "../../src/poller.ts";
import { startPoller } from "../../src/poller-cron.ts";
import { registerManagedRepo, setEpicStoreConfig } from "../../src/repo-config.ts";
import { appendQuestion } from "../../src/epic-store/index.ts";
import { readEpicFile, writeEpicFile } from "../../src/epic-store/epic-file-io.ts";
import { runFileWatcherTick } from "../../src/epic-store/watcher.ts";
import { renderEpicFile } from "../../src/epic-store/epic-file/renderer.ts";
import { getWorkflow } from "../../src/workflow-record.ts";
import {
  createImplementationWorkflow,
  RESUME_EVENT,
  type ImplementationDeps,
} from "../../src/workflows/implementation.ts";
import { createWorktree, destroyWorktree } from "../../src/worktree.ts";
import type { Database } from "bun:sqlite";

const SLUG = "rollout-epic-store";
const REPO = "o/file-repo";
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
let epicsDir: string;
let db: Database;
let engine: Engine;

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "middle-fw-")));
  repoPath = join(scratch, "repo");
  worktreeRoot = join(scratch, "worktrees");
  await git(scratch, ["init", "repo"]);
  await git(repoPath, ["commit", "--allow-empty", "-m", "init"]);
  epicsDir = join(repoPath, "planning", "epics");
  mkdirSync(epicsDir, { recursive: true });
  writeFileSync(
    join(epicsDir, `${SLUG}.md`),
    renderEpicFile({
      title: "feat: x",
      meta: { slug: SLUG, adapter: "stub" },
      context: "ctx",
      acceptanceCriteria: [{ checked: false, text: "ship" }],
      subIssues: [{ id: 1, checked: false, title: "1 — gateways", body: "" }],
      conversation: [],
    }),
  );
  db = openAndMigrate(join(scratch, "db.sqlite3"));
  registerManagedRepo(db, REPO, repoPath);
  setEpicStoreConfig(db, REPO, {
    mode: "file",
    epicsDir: "planning/epics",
    stateFile: ".middle/state.md",
  });
  engine = new Engine({ embedded: true });
});

afterEach(async () => {
  await engine.close(true);
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const hangingGate: SessionGate = {
  awaitSessionStart: async () =>
    ({ session_id: "stub", transcript_path: "/tmp/stub.jsonl" }) as HookPayload,
  awaitStop: () => new Promise<HookPayload>(() => {}),
};

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
      writeFileSync(
        join(opts.worktree, ".middle", "blocked.json"),
        JSON.stringify({ question: "?" }),
      );
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

/** A github PollGateway stub that surfaces no github-side resume (file mode resumes via the watcher). */
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
  async getRateLimit(): Promise<RateLimitStatus> {
    return { remaining: 5000, resetAt: 0 };
  },
};

function makeDeps(): ImplementationDeps {
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
    resolveEpicStoreMode: () => "file",
    enqueueContinuation: async (input) => {
      await engine.start("implementation", input);
    },
    postQuestion: async ({ epicRef, question, context, kind }) => {
      appendQuestion(epicsDir, epicRef, { question, context, kind });
    },
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

describe("file-watcher Q&A loop (#197)", () => {
  test("poller cron detects a non-empty answer edit and resumes the parked Epic to completion", async () => {
    engine.register(createImplementationWorkflow(makeDeps()));
    const handle = await engine.start("implementation", {
      repo: REPO,
      epicRef: SLUG,
      adapter: "stub",
    });
    await awaitState(handle.id, "waiting-human");
    // The park wrote an open question into the Epic file.
    const parked = readEpicFile(epicsDir, SLUG)!;
    expect(parked.conversation.some((e) => e.kind === "question" && e.status === "open")).toBe(
      true,
    );

    // Human edits the answer block to non-empty content (what the watcher detects).
    writeEpicFile(epicsDir, SLUG, {
      ...parked,
      conversation: parked.conversation.map((e) =>
        e.kind === "question" && e.id === 1 ? { ...e, answer: { body: "Go with A." } } : e,
      ),
    });

    // Boot the poller cron with the real file-watcher pass (since=0 so the first
    // tick catches the edit); the github poll side is a no-op stub.
    const stop = await startPoller(
      {
        db,
        github: stubGithubPoll,
        fireSignal: (id, payload) => engine.signal(id, RESUME_EVENT, payload),
      },
      {
        intervalMs: 40,
        fileWatcher: async () => {
          await runFileWatcherTick(
            {
              db,
              fileModeRepos: () => [{ repo: REPO, epicsDir }],
              fireSignal: (id, payload) => engine.signal(id, RESUME_EVENT, payload),
            },
            0,
          );
        },
      },
    );
    try {
      // The watcher fires the resume → continuation drives to completion.
      await awaitState(handle.id, "completed");
      // The answered question was flipped to resolved (dedup — won't re-fire).
      expect(
        readEpicFile(epicsDir, SLUG)!.conversation.find((e) => e.kind === "question")?.status,
      ).toBe("resolved");
    } finally {
      await stop();
    }
  });
});
