/**
 * Parity (#196): the load-bearing proof of the design's central promise — **no
 * workflow code changes between modes**. One fixture runs the real implementation
 * workflow end-to-end against each Epic-store backend (github vs file) and asserts
 * the same outcome for the same input:
 *   - a happy-path dispatch reaches `completed`;
 *   - a park → resume-answer → continuation reaches `completed`.
 * The only per-mode difference is where the agent's question lands (a recorded gh
 * comment vs a `<!-- middle:question -->` block in the Epic file) — the workflow
 * body, gates, and engine are identical. A future divergence here is the contract
 * catching a regression.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "bunqueue/workflow";
import type { AgentAdapter, HookPayload, StopClassification } from "@middle/core";
import { openAndMigrate } from "../../src/db.ts";
import type { SessionGate } from "../../src/hook-server.ts";
import { appendQuestion } from "../../src/epic-store/index.ts";
import { readEpicFile } from "../../src/epic-store/epic-file-io.ts";
import { renderEpicFile } from "../../src/epic-store/epic-file/renderer.ts";
import { getWaitForSignal, getWorkflow } from "../../src/workflow-record.ts";
import {
  createImplementationWorkflow,
  RESUME_EVENT,
  type ImplementationDeps,
  type ImplementationInput,
} from "../../src/workflows/implementation.ts";
import { createWorktree, destroyWorktree } from "../../src/worktree.ts";
import type { Database } from "bun:sqlite";

type Mode = "github" | "file";

const SLUG = "rollout-epic-store";
const REPO = "o/parity-repo";
/** github mode references a number; file mode references the slug. */
function epicRefFor(mode: Mode): string {
  return mode === "file" ? SLUG : "6";
}

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
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  }
}

let scratch: string;
let repoPath: string;
let worktreeRoot: string;
let epicsDir: string;
let db: Database;
let engine: Engine;

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "middle-parity-")));
  repoPath = join(scratch, "repo");
  worktreeRoot = join(scratch, "worktrees");
  await git(scratch, ["init", "repo"]);
  await git(repoPath, ["commit", "--allow-empty", "-m", "init"]);
  epicsDir = join(repoPath, "planning", "epics");
  mkdirSync(epicsDir, { recursive: true });
  // The file-mode Epic on disk (github mode ignores it).
  writeFileSync(
    join(epicsDir, `${SLUG}.md`),
    renderEpicFile({
      title: "feat: parity",
      meta: { slug: SLUG, adapter: "stub" },
      context: "ctx",
      acceptanceCriteria: [{ checked: false, text: "ship" }],
      subIssues: [{ id: 1, checked: false, title: "1 — gateways", body: "" }],
      conversation: [],
    }),
  );
  db = openAndMigrate(join(scratch, "db.sqlite3"));
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
const readyGate: SessionGate = {
  awaitSessionStart: async () =>
    ({ session_id: "stub", transcript_path: "/tmp/stub.jsonl" }) as HookPayload,
  awaitStop: async () => ({ reason: "turn-end" }) as HookPayload,
};

/** Stub adapter returning each classification in turn (last repeats). Writes a
 *  blocked.json on install so an `asked-question` drive parks via the real sentinel path. */
function makeAdapter(classifications: StopClassification[]): AgentAdapter {
  const seq = [...classifications];
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

type RecordedQuestion = { epicRef: string; question: string };

/**
 * Build implementation deps for a mode, sharing the stub adapter/tmux/worktree and
 * wiring `postQuestion` to the mode's real side-effect: github records the comment
 * (stand-in for the gh post), file appends a `<!-- middle:question -->` block to the
 * Epic file via the renderer. `gate` is the SessionGate (ready for the happy path,
 * hanging for the park path so the blocked.json sentinel decides the outcome).
 */
function buildTestDeps(
  mode: Mode,
  opts: { adapter: AgentAdapter; gate: SessionGate; recorded: RecordedQuestion[] },
): ImplementationDeps {
  return {
    db,
    getAdapter: () => opts.adapter,
    sessionGate: opts.gate,
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
    resolveEpicStoreMode: () => mode,
    enqueueContinuation: async (input) => {
      await engine.start("implementation", input);
    },
    postQuestion:
      mode === "file"
        ? async ({ epicRef, question, context, kind }) => {
            appendQuestion(epicsDir, epicRef, { question, context, kind });
          }
        : async ({ epicRef, question }) => {
            opts.recorded.push({ epicRef, question });
          },
  };
}

/** The github-mode test-deps builder (criterion: a named builder per mode). */
function buildTestDepsWithGitHubGateways(o: {
  adapter: AgentAdapter;
  gate: SessionGate;
  recorded: RecordedQuestion[];
}): ImplementationDeps {
  return buildTestDeps("github", o);
}
/** The file-mode test-deps builder. */
function buildTestDepsWithFileGateways(o: {
  adapter: AgentAdapter;
  gate: SessionGate;
  recorded: RecordedQuestion[];
}): ImplementationDeps {
  return buildTestDeps("file", o);
}

function buildFor(
  mode: Mode,
  o: { adapter: AgentAdapter; gate: SessionGate; recorded: RecordedQuestion[] },
): ImplementationDeps {
  return mode === "file" ? buildTestDepsWithFileGateways(o) : buildTestDepsWithGitHubGateways(o);
}

async function awaitState(id: string, state: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getWorkflow(db, id)?.state === state) return;
    await Bun.sleep(20);
  }
  throw new Error(`workflow ${id} did not reach '${state}' (was '${getWorkflow(db, id)?.state}')`);
}

describe.each<Mode>(["github", "file"])("implementation parity — %s mode", (mode) => {
  test("happy-path dispatch reaches completed", async () => {
    const recorded: RecordedQuestion[] = [];
    const deps = buildFor(mode, {
      adapter: makeAdapter([{ kind: "bare-stop" }]),
      gate: readyGate,
      recorded,
    });
    engine.register(createImplementationWorkflow(deps));
    const input: ImplementationInput = { repo: REPO, epicRef: epicRefFor(mode), adapter: "stub" };
    const handle = await engine.start("implementation", input);
    await awaitState(handle.id, "completed");
    // Identical terminal state, and the row carries the mode's ref.
    expect(getWorkflow(db, handle.id)?.epicRef).toBe(epicRefFor(mode));
  });

  test("park → resume-answer → continuation reaches completed", async () => {
    const recorded: RecordedQuestion[] = [];
    // First drive parks (asked-question via blocked.json + hanging Stop); the
    // continuation drives a bare-stop to completion.
    const deps = buildFor(mode, {
      adapter: makeAdapter([
        {
          kind: "asked-question",
          sentinelPath: "/x/.middle/blocked.json",
          sentinel: { question: "A or B?" },
        },
        { kind: "bare-stop" },
      ]),
      gate: hangingGate,
      recorded,
    });
    engine.register(createImplementationWorkflow(deps));
    const input: ImplementationInput = { repo: REPO, epicRef: epicRefFor(mode), adapter: "stub" };
    const handle = await engine.start("implementation", input);

    // Parked identically in both modes; the resume signal is armed.
    await awaitState(handle.id, "waiting-human");
    expect(getWaitForSignal(db, handle.id)).not.toBeNull();

    // Mode-appropriate park side-effect: file → a question block on disk; github → recorded.
    if (mode === "file") {
      expect(readEpicFile(epicsDir, SLUG)!.conversation.some((e) => e.kind === "question")).toBe(
        true,
      );
    } else {
      expect(recorded).toEqual([{ epicRef: "6", question: "A or B?" }]);
    }

    // `mm resume`'s fire (control.resume): signal the parked execution with the answer.
    await engine.signal(handle.id, RESUME_EVENT, {
      reason: "answered-question",
      reply: { commentId: 0, authorLogin: "human", body: "Go with A." },
    });
    // The original execution hands off to the continuation, which completes.
    await awaitState(handle.id, "completed");
  });
});
