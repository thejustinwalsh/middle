/**
 * The file-mode end-to-end smoke: drive the **real** implementation workflow
 * through the full file-mode loop — dispatch → park-on-question →
 * answer-via-file-edit → resume → complete — against a throwaway tmpdir git repo
 * configured `epic_store="file"`, with the gh boundary stubbed at `EpicGateway`'s
 * PR/comment methods only. Everything else is the production path: the real
 * `Engine`, `createImplementationWorkflow`, `createWorktree`, the real
 * `makeDefaultPostQuestion` (file branch → `appendQuestion`), and the real
 * `runFileWatcherTick` that turns a human's answer-block edit into the resume
 * signal exactly as the daemon's poller cron does.
 *
 * This is the deterministic foundation the live-smoke harness rests on. It is
 * consumed by two callers — `packages/dispatcher/test/epic-store/live-smoke.test.ts`
 * (the CI integration test, which asserts the deep invariants) and `mm
 * verify-file-mode` (the operator command, which formats {@link SmokeResult} into
 * a structured report). One drive, two consumers — so the command can never drift
 * from what CI proves.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "bunqueue/workflow";
import type { AgentAdapter, HookPayload, StopClassification } from "@middle/core";
import { makeDefaultPostQuestion } from "../build-deps.ts";
import { openAndMigrate } from "../db.ts";
import type { EpicGateway } from "../github.ts";
import type { SessionGate } from "../hook-server.ts";
import { registerManagedRepo, setEpicStoreConfig } from "../repo-config.ts";
import { getWaitForSignal, getWorkflow } from "../workflow-record.ts";
import {
  createImplementationWorkflow,
  RESUME_EVENT,
  type ImplementationDeps,
} from "../workflows/implementation.ts";
import { createWorktree, destroyWorktree } from "../worktree.ts";
import { epicFilePath, readEpicFile, writeEpicFile } from "./epic-file-io.ts";
import type { ConversationEntry, EpicFile } from "./epic-file/types.ts";
import { renderEpicFile } from "./epic-file/renderer.ts";
import { runFileWatcherTick } from "./watcher.ts";

/** The seven phases of the smoke, in drive order — also the report section names. */
export const SMOKE_SECTIONS = [
  "init",
  "author",
  "dispatch",
  "park",
  "answer",
  "resume",
  "complete",
] as const;
/** A smoke section identifier — one of {@link SMOKE_SECTIONS}; orders the drive and names a report line. */
export type SmokeSectionName = (typeof SMOKE_SECTIONS)[number];

/** One phase's result: did it pass, how long it took, and a one-line detail. */
export type SmokeSection = {
  name: SmokeSectionName;
  ok: boolean;
  ms: number;
  detail: string;
};

/** The structured outcome of one smoke run — the report source and the test's assertion surface. */
export type SmokeResult = {
  /** True iff every section passed. */
  ok: boolean;
  sections: SmokeSection[];
  /** Name of the first failed section (the report's last line), or null on success. */
  failedSection: SmokeSectionName | null;
  /** The repo Epic file's conversation after the full loop (one question, answered + resolved). */
  conversation: ConversationEntry[];
  /** Raw markdown of the repo Epic file after the loop — for marker-count assertions. */
  rawEpicText: string;
  /** The worktree's Epic file as the agent left it (checkbox flipped), captured before teardown. */
  worktreeEpic: EpicFile | null;
  /** The worktree path the resume drive ran in (proves the agent worked in the worktree). */
  worktreePath: string | null;
  /** gh comment/post calls the run made — must be empty in file mode (gh stub untouched). */
  ghCalls: Array<{ method: string; repo: string; ref: string }>;
  /** The throwaway scratch dir — removed by the runner; the caller asserts it's gone. */
  scratchDir: string;
  /** True once the scratch dir was removed (cleanup ran regardless of outcome). */
  cleanedUp: boolean;
};

/** Tunables (the test/command can shorten or lengthen the in-drive waits). */
export type SmokeOptions = {
  launchTimeoutMs?: number;
  stopTimeoutMs?: number;
  livenessPollMs?: number;
  /** How long to wait for each workflow-state transition before failing the section. */
  stateTimeoutMs?: number;
};

const SLUG = "verify-file-mode-smoke";
const REPO = "middle-smoke/file-repo";
const QUESTION = "Approach A or B?";
const ANSWER = "Go with A.";
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "middle-smoke",
  GIT_AUTHOR_EMAIL: "middle-smoke@example.invalid",
  GIT_COMMITTER_NAME: "middle-smoke",
  GIT_COMMITTER_EMAIL: "middle-smoke@example.invalid",
};

/** Run a git subcommand in `cwd` with the smoke's fixed identity env; throws with stderr on non-zero exit. */
async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "ignore",
    stderr: "pipe",
    env: GIT_ENV,
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")}: ${(await new Response(proc.stderr).text()).trim()}`);
  }
}

/** A SessionGate whose Stop wait never resolves — the smoke's outcome is decided
 *  by the stub adapter's classification + the always-present blocked.json sentinel
 *  (the same shape `parity.test.ts` uses), not by a real Stop hook. */
const hangingGate: SessionGate = {
  awaitSessionStart: async () =>
    ({ session_id: "smoke", transcript_path: "/tmp/smoke.jsonl" }) as HookPayload,
  awaitStop: () => new Promise<HookPayload>(() => {}),
};

/** Poll `getWorkflow(...).state` until it equals `state` or the deadline passes. */
async function awaitState(
  db: ReturnType<typeof openAndMigrate>,
  id: string,
  state: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getWorkflow(db, id)?.state === state) return;
    await Bun.sleep(20);
  }
  throw new Error(`workflow did not reach '${state}' (was '${getWorkflow(db, id)?.state}')`);
}

/**
 * Run the full file-mode smoke once. Never throws for a *workflow* failure — it
 * captures the failing section in {@link SmokeResult} and always tears the
 * scratch dir down. It only throws if cleanup itself fails (a real disk fault).
 */
export async function runFileModeSmoke(opts: SmokeOptions = {}): Promise<SmokeResult> {
  const launchTimeoutMs = opts.launchTimeoutMs ?? 2000;
  const stopTimeoutMs = opts.stopTimeoutMs ?? 2000;
  const livenessPollMs = opts.livenessPollMs ?? 20;
  const stateTimeoutMs = opts.stateTimeoutMs ?? 8000;

  const sections: SmokeSection[] = [];
  let failedSection: SmokeSectionName | null = null;

  // Shared mutable state across sections (assigned as the drive progresses).
  let scratch = "";
  let repoPath = "";
  let epicsDir = "";
  let worktreeRoot = "";
  let db: ReturnType<typeof openAndMigrate> | null = null;
  let engine: Engine | null = null;
  let workflowId = "";
  const ghCalls: Array<{ method: string; repo: string; ref: string }> = [];
  let worktreeEpic: EpicFile | null = null;
  let worktreePath: string | null = null;
  let conversation: ConversationEntry[] = [];
  let rawEpicText = "";

  // The gh stub: file mode never calls it, so any call is a contract violation
  // the caller asserts against. Shaped as the slice `makeDefaultPostQuestion` reads.
  const ghStub = {
    async listIssueComments(repo: string, ref: string) {
      ghCalls.push({ method: "listIssueComments", repo, ref });
      return [];
    },
    async postComment(repo: string, ref: string) {
      ghCalls.push({ method: "postComment", repo, ref });
    },
  } as unknown as EpicGateway;

  // The stub adapter: always writes a blocked.json (so a hung session parks on
  // the sentinel rather than throwing), classifies the first drive as a question
  // and the resume drive as a bare-stop, and on the resume drive does the agent's
  // "work" — flip the `<sub-issue id=1>` checkbox in the worktree. The worktree
  // Epic file is captured then, because `finalize` destroys the worktree on the
  // completed terminal (a post-completion read would find nothing).
  let installCount = 0;
  let classifyIdx = 0;
  const classifications: StopClassification[] = [
    {
      kind: "asked-question",
      sentinelPath: "/x/.middle/blocked.json",
      sentinel: { question: QUESTION },
    },
    { kind: "bare-stop" },
  ];
  const adapter: AgentAdapter = {
    name: "stub",
    readyEvent: "session.started",
    async installHooks(o) {
      installCount += 1;
      mkdirSync(join(o.worktree, ".middle"), { recursive: true });
      writeFileSync(
        join(o.worktree, ".middle", "blocked.json"),
        JSON.stringify({ question: QUESTION }),
      );
      if (installCount >= 2) {
        const wtEpicsDir = join(o.worktree, "planning", "epics");
        const epic = readEpicFile(wtEpicsDir, SLUG);
        if (epic) {
          writeEpicFile(wtEpicsDir, SLUG, {
            ...epic,
            subIssues: epic.subIssues.map((s) => (s.id === 1 ? { ...s, checked: true } : s)),
          });
          worktreeEpic = readEpicFile(wtEpicsDir, SLUG);
          worktreePath = o.worktree;
        }
      }
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
    classifyStop: () => classifications[Math.min(classifyIdx++, classifications.length - 1)]!,
  };

  /** Run one section, time it, record the result; skip if a prior section failed. */
  async function section(name: SmokeSectionName, body: () => Promise<string>): Promise<void> {
    if (failedSection !== null) {
      sections.push({ name, ok: false, ms: 0, detail: `skipped after '${failedSection}' failed` });
      return;
    }
    const start = Date.now();
    try {
      const detail = await body();
      sections.push({ name, ok: true, ms: Date.now() - start, detail });
    } catch (error) {
      failedSection = name;
      sections.push({ name, ok: false, ms: Date.now() - start, detail: (error as Error).message });
    }
  }

  try {
    await section("init", async () => {
      scratch = realpathSync(mkdtempSync(join(tmpdir(), "middle-smoke-")));
      repoPath = join(scratch, "repo");
      worktreeRoot = join(scratch, "worktrees");
      epicsDir = join(repoPath, "planning", "epics");
      await git(scratch, ["init", "repo"]);
      await git(repoPath, ["commit", "--allow-empty", "-m", "init"]);
      return `tmpdir repo at ${repoPath}`;
    });

    await section("author", async () => {
      mkdirSync(epicsDir, { recursive: true });
      writeFileSync(
        epicFilePath(epicsDir, SLUG),
        renderEpicFile({
          title: "feat: file-mode smoke",
          meta: { slug: SLUG, adapter: "stub" },
          context: "Verify the file-mode workflow end to end.",
          acceptanceCriteria: [{ checked: false, text: "ship" }],
          subIssues: [{ id: 1, checked: false, title: "1 — gateways", body: "" }],
          conversation: [],
        }),
      );
      // Commit the Epic file so the worktree checkout (HEAD) contains it — without
      // this, `git worktree add` yields a worktree missing planning/epics/.
      await git(repoPath, ["add", "planning/epics"]);
      await git(repoPath, ["commit", "-m", "author epic"]);

      db = openAndMigrate(join(scratch, "db.sqlite3"));
      registerManagedRepo(db, REPO, repoPath);
      setEpicStoreConfig(db, REPO, {
        mode: "file",
        epicsDir: "planning/epics",
        stateFile: ".middle/state.md",
      });
      engine = new Engine({ embedded: true });
      return `authored ${SLUG}.md (epic_store=file)`;
    });

    await section("dispatch", async () => {
      const deps: ImplementationDeps = {
        db: db!,
        getAdapter: () => adapter,
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
        launchTimeoutMs,
        stopTimeoutMs,
        livenessPollMs,
        resolveEpicStoreMode: () => "file",
        enqueueContinuation: async (input) => {
          await engine!.start("implementation", input);
        },
        // The real file-mode poster: appends a <!-- middle:question --> block.
        postQuestion: makeDefaultPostQuestion({
          db: db!,
          resolveRepoPath: () => repoPath,
          github: ghStub,
        }),
      };
      engine!.register(createImplementationWorkflow(deps));
      const handle = await engine!.start("implementation", {
        repo: REPO,
        epicRef: SLUG,
        adapter: "stub",
      });
      workflowId = handle.id;
      return `workflow ${workflowId} started`;
    });

    await section("park", async () => {
      await awaitState(db!, workflowId, "waiting-human", stateTimeoutMs);
      if (getWaitForSignal(db!, workflowId) === null) {
        throw new Error("parked but no resume signal armed");
      }
      const epic = readEpicFile(epicsDir, SLUG);
      const open =
        epic?.conversation.filter((e) => e.kind === "question" && e.status === "open") ?? [];
      if (open.length !== 1) throw new Error(`expected one open question, found ${open.length}`);
      return "parked waiting-human; question block written to the Epic file";
    });

    await section("answer", async () => {
      // The human's edit: fill in the open question's answer block.
      const epic = readEpicFile(epicsDir, SLUG);
      if (!epic) throw new Error("Epic file vanished before the answer edit");
      writeEpicFile(epicsDir, SLUG, {
        ...epic,
        conversation: epic.conversation.map((e) =>
          e.kind === "question" && e.status === "open" ? { ...e, answer: { body: ANSWER } } : e,
        ),
      });
      return "answer block filled in on disk";
    });

    await section("resume", async () => {
      // Drive the REAL file-watcher — mtime poll detects the now-non-empty answer
      // and fires the resume signal, exactly as the daemon's poller cron does.
      const fired = await runFileWatcherTick(
        {
          db: db!,
          fileModeRepos: () => [{ repo: REPO, epicsDir }],
          fireSignal: (id, payload) => engine!.signal(id, RESUME_EVENT, payload),
        },
        0,
      );
      if (fired !== 1) throw new Error(`file-watcher fired ${fired} signals, expected 1`);
      return "file-watcher detected the answer edit and fired the resume";
    });

    await section("complete", async () => {
      await awaitState(db!, workflowId, "completed", stateTimeoutMs);
      const epic = readEpicFile(epicsDir, SLUG);
      conversation = epic?.conversation ?? [];
      rawEpicText = readFileSync(epicFilePath(epicsDir, SLUG), "utf8");
      return "workflow reached completed";
    });
  } finally {
    // Cleanup runs regardless of outcome — no leaked .middle/ dirs in /tmp. The
    // casts re-assert the declared type: TS narrows these closure-assigned `let`s
    // to their `null` initializer (it doesn't track the in-closure assignments).
    await (engine as Engine | null)?.close(true);
    (db as ReturnType<typeof openAndMigrate> | null)?.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }

  return {
    ok: failedSection === null,
    sections,
    failedSection,
    conversation,
    rawEpicText,
    worktreeEpic,
    worktreePath,
    ghCalls,
    scratchDir: scratch,
    cleanedUp: true,
  };
}
