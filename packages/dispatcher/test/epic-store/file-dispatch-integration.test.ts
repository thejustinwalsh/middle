/**
 * Integration: a file-mode dispatch through the real implementation workflow and
 * the real `buildImplementationDeps` selector.
 *
 * Test A drives the actual workflow (real engine + `createWorktree`, stub
 * adapter/gate/tmux) for a `epic_store="file"` repo whose agent parks asking a
 * question, and asserts the workflow row carries the slug as `epic_ref` AND the
 * Epic file gains a re-parseable `<!-- middle:question -->` block.
 *
 * Test B exercises the real `buildImplementationDeps` wiring (no hand-rolled
 * postQuestion): the per-repo selector routes the `postQuestion` seam to the
 * file-backed writer for a file repo and to the gh comment poster for a github
 * repo.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "bunqueue/workflow";
import type { AgentAdapter, HookPayload, StopClassification } from "@middle/core";
import { buildImplementationDeps } from "../../src/build-deps.ts";
import { openAndMigrate } from "../../src/db.ts";
import type { EpicGateway } from "../../src/github.ts";
import type { SessionGate } from "../../src/hook-server.ts";
import { registerManagedRepo, setEpicStoreConfig } from "../../src/repo-config.ts";
import { readEpicFile } from "../../src/epic-store/epic-file-io.ts";
import { appendQuestion } from "../../src/epic-store/index.ts";
import { renderEpicFile } from "../../src/epic-store/epic-file/renderer.ts";
import { getWorkflow } from "../../src/workflow-record.ts";
import {
  createImplementationWorkflow,
  type ImplementationDeps,
} from "../../src/workflows/implementation.ts";
import { createWorktree, destroyWorktree } from "../../src/worktree.ts";
import type { Database } from "bun:sqlite";

const SLUG = "rollout-epic-store";
const REPO = "o/file-repo";
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

let scratch: string;
let repoPath: string;
let worktreeRoot: string;
let epicsDir: string;
let db: Database;
let engine: Engine;

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "middle-fdisp-")));
  repoPath = join(scratch, "repo");
  worktreeRoot = join(scratch, "worktrees");
  await git(scratch, ["init", "repo"]);
  await git(repoPath, ["commit", "--allow-empty", "-m", "init"]);
  epicsDir = join(repoPath, "planning", "epics");
  mkdirSync(epicsDir, { recursive: true });
  writeFileSync(
    join(epicsDir, `${SLUG}.md`),
    renderEpicFile({
      title: "feat: file-backed epic store",
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

/** A SessionGate whose Stop wait never resolves — models an agent that hangs. */
const hangingGate: SessionGate = {
  awaitSessionStart: async () =>
    ({ session_id: "stub", transcript_path: "/tmp/stub.jsonl" }) as HookPayload,
  awaitStop: () => new Promise<HookPayload>(() => {}),
};

/** Adapter that writes a real `.middle/blocked.json` on installHooks → asked-question. */
function blockedAdapter(): AgentAdapter {
  const asked: StopClassification = {
    kind: "asked-question",
    sentinelPath: "/x/.middle/blocked.json",
    sentinel: { question: "Approach A or B?" },
  };
  return {
    name: "stub",
    readyEvent: "session.started",
    async installHooks(opts) {
      mkdirSync(join(opts.worktree, ".middle"), { recursive: true });
      writeFileSync(
        join(opts.worktree, ".middle", "blocked.json"),
        JSON.stringify({ question: "Approach A or B?" }),
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
    classifyStop: () => asked,
  };
}

function makeDeps(over: Partial<ImplementationDeps>): ImplementationDeps {
  return {
    db,
    getAdapter: () => blockedAdapter(),
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
    enqueueContinuation: async () => {
      throw new Error("unexpected continuation");
    },
    // file-mode postQuestion: append a question block to the Epic file (the seam
    // the real build-deps wires; exercised directly in Test B below).
    postQuestion: async ({ epicRef, question, context, kind }) => {
      appendQuestion(epicsDir, epicRef, { question, context, kind });
    },
    ...over,
  };
}

async function awaitParked(id: string, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getWorkflow(db, id)?.state === "waiting-human") return;
    await Bun.sleep(20);
  }
  throw new Error(`workflow ${id} did not park (state '${getWorkflow(db, id)?.state}')`);
}

describe("file-mode dispatch — Test A: real workflow drive", () => {
  test("a file-mode Epic parks asking a question → row carries the slug, Epic file gains a question block", async () => {
    engine.register(createImplementationWorkflow(makeDeps({})));
    const handle = await engine.start("implementation", {
      repo: REPO,
      epicRef: SLUG,
      adapter: "stub",
    });
    await awaitParked(handle.id);

    // The workflow row carries the slug as epic_ref (and a null numeric epic_number).
    const row = getWorkflow(db, handle.id);
    expect(row?.epicRef).toBe(SLUG);
    expect(row?.epicNumber).toBeNull();

    // The Epic file gained a re-parseable question block (round-trip survived the write).
    const epic = readEpicFile(epicsDir, SLUG);
    expect(epic!.conversation).toHaveLength(1);
    expect(epic!.conversation[0]).toMatchObject({ kind: "question", status: "open", id: 1 });
  });
});

describe("file-mode dispatch — Test B: real buildImplementationDeps selector", () => {
  test("postQuestion routes to the Epic file for a file repo, and to gh for a github repo", async () => {
    const ghCalls: Array<{ repo: string; ref: string; body: string }> = [];
    const ghStub = {
      async postComment(repo: string, ref: string, body: string) {
        ghCalls.push({ repo, ref, body });
      },
    } as unknown as EpicGateway;

    const { deps } = await buildImplementationDeps({
      db,
      getAdapter: () => blockedAdapter(),
      resolveRepoPath: () => repoPath,
      worktreeRoot,
      enqueueContinuation: async () => {},
      bindServer: () => ({ sessionGate: hangingGate, dispatcherUrl: "http://127.0.0.1:0" }),
      github: ghStub,
      resolveAgentLogin: async () => "middle-bot",
    });

    // file repo → the question lands in the Epic file; gh is NOT called.
    await deps.postQuestion!({ repo: REPO, epicRef: SLUG, question: "A or B?", kind: "question" });
    expect(ghCalls).toHaveLength(0);
    const epic = readEpicFile(epicsDir, SLUG);
    expect(epic!.conversation[0]).toMatchObject({ kind: "question", body: "A or B?" });

    // github repo (no config row) → the question is posted via gh.
    await deps.postQuestion!({ repo: "o/gh-repo", epicRef: "7", question: "Q?", kind: "question" });
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]).toMatchObject({ repo: "o/gh-repo", ref: "7" });
    expect(ghCalls[0]!.body).toContain("Q?");
  });
});
