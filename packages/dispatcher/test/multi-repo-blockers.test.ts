import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, HookPayload, RepoConfig } from "@middle/core";
import { isParseError, parseStateIssue, renderStateIssue } from "@middle/state-issue";
import type { BlockedItem, ReadyRow } from "@middle/state-issue";
import { Engine } from "bunqueue/workflow";
import { openAndMigrate } from "../src/db.ts";
import type { Database } from "bun:sqlite";
import type { EpicGateway, EpicListItem, IssueState } from "../src/github.ts";
import type { SessionGate } from "../src/hook-server.ts";
import type { StateGateway } from "../src/state-issue.ts";
import {
  createRecommenderWorkflow,
  type RecommenderContext,
  type RecommenderInput,
} from "../src/workflows/recommender.ts";

// #225 — runtime resolution of cross-repo `BlockedItem.blocker` references, driven
// through the REAL recommender workflow (engine → steps → resolve-blockers → state
// write), observed via the live state body — not a unit-level call to
// `resolveBlockers`. Repo A's Epic #10 is blocked on Repo B's `acme/b#7`; closing
// `acme/b#7` must move Repo A's Epic from `## Blocked` to `## Ready to dispatch`
// within one recommender tick. A 404 blocker stays blocked with a stale suffix.

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

const REPO_A = "acme/a";
const STATE_ISSUE = 99;
const REPO_CONFIG: RepoConfig = { adapters: ["stub"] };
const EMPTY_CONTEXT: RecommenderContext = {
  rateLimits: { claude: "AVAILABLE", codex: "UNKNOWN", github: "UNKNOWN" },
  inFlight: [],
  slots: { perAdapter: {}, total: { used: 0, max: 0, globalUsed: 0, globalMax: 0 } },
};

let scratch: string;
let repoPath: string;
let worktreeRoot: string;
let db: Database;
let engine: Engine;

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "middle-blockers-")));
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

/** Repo A's state body with the given Blocked items (Ready/everything-else empty). */
function bodyWithBlocked(blocked: BlockedItem[], ready: ReadyRow[] = []): string {
  return renderStateIssue({
    version: 1,
    generated: new Date().toISOString(),
    runId: "00000000",
    intervalMinutes: 15,
    readyToDispatch: ready,
    needsHumanInput: [],
    blocked,
    inFlight: [],
    excluded: [],
    rateLimits: { claude: "AVAILABLE", codex: "UNKNOWN", github: "UNKNOWN" },
    slotUsage: { adapters: [], total: { used: 0, max: 0 }, global: { used: 0, max: 0 } },
  });
}

/** An in-memory two-repo issue table behind a real `EpicGateway` shape. */
function makeGateways(opts: {
  issues: Record<string, IssueState>; // keyed "repo#n"
  epicsA: EpicListItem[]; // Repo A's open Epics (for accurate Ready rows)
}) {
  let body = "";
  const stateGateway: StateGateway = {
    async readBody() {
      return body;
    },
    async writeBody(_repo, _issue, next) {
      body = next;
    },
  };
  const table = { ...opts.issues };
  const epicGateway = {
    async listOpenEpics(repo: string): Promise<EpicListItem[]> {
      return repo === REPO_A ? opts.epicsA : [];
    },
    async getIssueState(repo: string, ref: string): Promise<IssueState | null> {
      return table[`${repo}#${ref}`] ?? null;
    },
  } as unknown as EpicGateway;
  return {
    stateGateway,
    epicGateway,
    setBody: (b: string) => {
      body = b;
    },
    getBody: () => body,
    closeIssue: (key: string) => {
      const cur = table[key];
      if (cur) table[key] = { ...cur, state: "closed" };
    },
  };
}

/** A stub adapter + session gate so the spawn step is a no-op (the body is preloaded). */
function stubAdapter(): AgentAdapter {
  return {
    name: "stub",
    readyEvent: "session.started",
    async installHooks() {},
    buildLaunchCommand: () => ({ argv: ["true"], env: {} }),
    buildPromptText: () => "/recommending-github-issues",
    async enterAutoMode() {},
    resolveTranscriptPath: (p) => p.transcript_path as string,
    readTranscriptState: () => ({
      lastActivity: "",
      contextTokens: 0,
      turnCount: 0,
      lastToolUse: null,
    }),
    classifyStop: () => ({ kind: "done" }),
  };
}

function stubGate(): SessionGate {
  return {
    awaitSessionStart: async () =>
      ({ session_id: "s", transcript_path: "/tmp/s.jsonl" }) as HookPayload,
    awaitStop: async () => ({ reason: "turn-end" }) as HookPayload,
  };
}

/** Register the recommender workflow once on the shared engine, bound to `gw`. */
function register(gw: ReturnType<typeof makeGateways>): void {
  engine.register(
    createRecommenderWorkflow({
      db,
      getAdapter: () => stubAdapter(),
      sessionGate: stubGate(),
      tmux: {
        async newSession() {},
        async sendText() {},
        async sendEnter() {},
        async killSession() {},
      },
      worktree: {
        async createWorktree() {
          return {
            repoPath,
            path: join(worktreeRoot, "rec"),
            branch: "rec",
            repo: REPO_A,
            unit: "recommender",
          };
        },
        async destroyWorktree() {},
      },
      resolveRepoPath: () => repoPath,
      worktreeRoot,
      dispatcherUrl: "http://127.0.0.1:8822",
      schemaPath: "/abs/schemas/state-issue.v1.md",
      stateIssue: gw.stateGateway,
      epicGateway: gw.epicGateway,
      repoConfig: REPO_CONFIG,
      config: { defaultAdapter: "stub", autoDispatch: false, prMode: "worktree" },
      gatherContext: () => EMPTY_CONTEXT,
      launchTimeoutMs: 2000,
      agentTimeoutMs: 2000,
    }),
  );
}

/** Run one recommender tick through the engine and return the resulting state body. */
async function runTick(gw: ReturnType<typeof makeGateways>): Promise<string> {
  const input: RecommenderInput = { repo: REPO_A, stateIssue: STATE_ISSUE, adapter: "stub" };
  const handle = await engine.start("recommender", input);
  const terminal = new Set(["completed", "failed", "compensated", "cancelled"]);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const s = engine.getExecution(handle.id)?.state;
    if (s && terminal.has(s)) break;
    await Bun.sleep(15);
  }
  return gw.getBody();
}

function parse(body: string) {
  const p = parseStateIssue(body);
  if (isParseError(p)) throw new Error(`state body did not parse: ${p.message}`);
  return p;
}

describe("multi-repo cross-repo blocker resolution (#225) — through the workflow", () => {
  test("an open cross-repo blocker keeps the Epic blocked, annotated with Repo B's title", async () => {
    const gw = makeGateways({
      issues: { "acme/b#7": { state: "open", title: "Repo B epic" } },
      epicsA: [
        {
          ref: "10",
          number: 10,
          title: "Dashboard epic",
          state: "open",
          labels: [],
          subTotal: 3,
          subClosed: 0,
        },
      ],
    });
    gw.setBody(
      bodyWithBlocked([{ issue: 10, blocker: "acme/b#7", context: "needs Repo B's epic" }]),
    );

    register(gw);
    const after = parse(await runTick(gw));
    expect(after.readyToDispatch).toEqual([]);
    expect(after.blocked).toHaveLength(1);
    expect(after.blocked[0]!.blocker).toBe("acme/b#7 (Repo B epic)");
  });

  test("closing the cross-repo blocker moves the Epic to Ready within one tick", async () => {
    const gw = makeGateways({
      issues: { "acme/b#7": { state: "open", title: "Repo B epic" } },
      epicsA: [
        {
          ref: "10",
          number: 10,
          title: "Dashboard epic",
          state: "open",
          labels: [],
          subTotal: 3,
          subClosed: 1,
        },
      ],
    });
    gw.setBody(
      bodyWithBlocked([{ issue: 10, blocker: "acme/b#7", context: "needs Repo B's epic" }]),
    );

    register(gw);
    // Tick 1: blocker still open → stays blocked.
    let after = parse(await runTick(gw));
    expect(after.blocked).toHaveLength(1);
    expect(after.readyToDispatch).toEqual([]);

    // Repo B closes its Epic.
    gw.closeIssue("acme/b#7");

    // Tick 2: blocker resolved → Epic #10 is now Ready to dispatch.
    after = parse(await runTick(gw));
    expect(after.blocked).toEqual([]);
    expect(after.readyToDispatch).toHaveLength(1);
    const row = after.readyToDispatch[0]!;
    expect(row.epic).toBe("#10 Dashboard epic");
    expect(row.adapter).toBe("stub");
    expect(row.subIssues).toBe(2); // 3 total − 1 closed
    expect(row.reason).toContain("acme/b#7");
  });

  test("an unresolvable (404) blocker stays blocked with a (stale blocker: <ref>) suffix", async () => {
    const gw = makeGateways({
      issues: {}, // acme/b#999 resolves to null (404)
      epicsA: [],
    });
    gw.setBody(bodyWithBlocked([{ issue: 11, blocker: "acme/b#999", context: "gone" }]));

    register(gw);
    const after = parse(await runTick(gw));
    expect(after.blocked).toHaveLength(1);
    expect(after.blocked[0]!.blocker).toBe("acme/b#999 (stale blocker: acme/b#999)");
    expect(after.readyToDispatch).toEqual([]);
  });

  test("the resolved state body round-trips byte-identically", async () => {
    const gw = makeGateways({
      issues: { "acme/b#7": { state: "open", title: "Repo B epic" } },
      epicsA: [],
    });
    gw.setBody(
      bodyWithBlocked([
        { issue: 10, blocker: "acme/b#7", context: "open dep" },
        { issue: 11, blocker: "acme/b#999", context: "stale dep" },
      ]),
    );
    register(gw);
    const body = await runTick(gw);
    expect(renderStateIssue(parse(body))).toBe(body);
  });
});
