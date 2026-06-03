/**
 * Integration (#195): a file-mode dispatch mirrors the file-mode commands
 * reference into the dispatched agent's worktree. Drives the real implementation
 * workflow (stub adapter/gate/tmux, real engine + `createWorktree`) for a repo
 * whose installed skill carries `references/file-mode-commands.md`, and asserts
 * the worktree gains `.middle/skills/implementing-github-issues/references/
 * file-mode-commands.md` byte-identical to the source in `packages/skills/`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "bunqueue/workflow";
import type { AgentAdapter, HookPayload, StopClassification } from "@middle/core";
import { openAndMigrate } from "../../src/db.ts";
import type { SessionGate } from "../../src/hook-server.ts";
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
const SKILL_REF_REL = join(
  "skills",
  "implementing-github-issues",
  "references",
  "file-mode-commands.md",
);
// The canonical reference the mirror's source is installed from (test runs from repo root).
const SOURCE_REF = join(
  process.cwd(),
  "packages",
  "skills",
  SKILL_REF_REL.replace(/^skills\//, ""),
);

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
let db: Database;
let engine: Engine;

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "middle-mirror-")));
  repoPath = join(scratch, "repo");
  worktreeRoot = join(scratch, "worktrees");
  await git(scratch, ["init", "repo"]);
  // Install the implementer skill's file-mode reference into the repo (as `mm init`
  // would) and an Epic file, then commit so the git worktree checkout carries them.
  const installedRef = join(repoPath, ".claude", SKILL_REF_REL);
  mkdirSync(join(repoPath, ".claude", "skills", "implementing-github-issues", "references"), {
    recursive: true,
  });
  cpSync(SOURCE_REF, installedRef);
  const epicsDir = join(repoPath, "planning", "epics");
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
  await git(repoPath, ["add", "-A"]);
  await git(repoPath, ["commit", "-m", "init"]);
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

function blockedAdapter(): AgentAdapter {
  const asked: StopClassification = {
    kind: "asked-question",
    sentinelPath: "/x/.middle/blocked.json",
    sentinel: { question: "A or B?" },
  };
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
    enqueueContinuation: async () => {},
    postQuestion: async () => {},
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

describe("dispatch brief — mode-commands mirror (#195)", () => {
  test("a file-mode dispatch mirrors file-mode-commands.md into the worktree, byte-identical", async () => {
    engine.register(createImplementationWorkflow(makeDeps({ resolveEpicStoreMode: () => "file" })));
    const handle = await engine.start("implementation", {
      repo: REPO,
      epicRef: SLUG,
      adapter: "stub",
    });
    await awaitParked(handle.id);

    const worktreePath = getWorkflow(db, handle.id)?.worktreePath;
    expect(worktreePath).toBeTruthy();
    const mirrored = join(worktreePath!, ".middle", SKILL_REF_REL);
    expect(readFileSync(mirrored, "utf8")).toBe(readFileSync(SOURCE_REF, "utf8"));
  });

  test("a github-mode dispatch does not mirror the file-mode reference", async () => {
    engine.register(
      createImplementationWorkflow(makeDeps({ resolveEpicStoreMode: () => "github" })),
    );
    const handle = await engine.start("implementation", {
      repo: REPO,
      epicRef: SLUG,
      adapter: "stub",
    });
    await awaitParked(handle.id);

    const worktreePath = getWorkflow(db, handle.id)?.worktreePath;
    // github mode mirrors github-mode-commands.md (absent here) → no file-mode file.
    const mirrored = join(worktreePath!, ".middle", SKILL_REF_REL);
    expect(() => readFileSync(mirrored, "utf8")).toThrow();
  });
});
