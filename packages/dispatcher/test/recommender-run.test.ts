import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, HookPayload } from "@middle/core";
import { renderStateIssue } from "@middle/state-issue";
import { openAndMigrate } from "../src/db.ts";
import type { SessionGate } from "../src/hook-server.ts";
import {
  dispatchRecommender,
  type DispatchRecommenderOptions,
  type RecommenderRunOverrides,
} from "../src/recommender-run.ts";
import type { RecommenderContext } from "../src/workflows/recommender.ts";

let scratch: string;
let repoPath: string;

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
  if ((await proc.exited) !== 0)
    throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
}

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "middle-recrun-")));
  repoPath = join(scratch, "repo");
  await git(scratch, ["init", "repo"]);
  await git(repoPath, ["commit", "--allow-empty", "-m", "init"]);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function validBody(): string {
  return renderStateIssue({
    version: 1,
    generated: new Date().toISOString(),
    runId: "00000000",
    intervalMinutes: 15,
    readyToDispatch: [],
    needsHumanInput: [],
    blocked: [],
    inFlight: [],
    excluded: [],
    rateLimits: { claude: "AVAILABLE", codex: "UNKNOWN", github: "UNKNOWN" },
    slotUsage: { adapters: [], total: { used: 0, max: 0 }, global: { used: 0, max: 0 } },
  });
}

const STUB_CONTEXT: RecommenderContext = {
  rateLimits: { claude: "AVAILABLE", codex: "UNKNOWN", github: "UNKNOWN" },
  inFlight: [],
  slots: {
    perAdapter: { claude: { used: 0, max: 2 } },
    total: { used: 0, max: 2, globalUsed: 0, globalMax: 4 },
  },
};

function stubAdapter(): AgentAdapter {
  return {
    name: "claude",
    readyEvent: "session.started",
    async installHooks() {},
    buildLaunchCommand: () => ({ argv: ["true"], env: {} }),
    buildPromptText: (o) => `/recommending-github-issues @${o.promptFile}`,
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

function makeOverrides(extra?: Partial<RecommenderRunOverrides>): RecommenderRunOverrides {
  const gate: SessionGate = {
    awaitSessionStart: async () =>
      ({ session_id: "s", transcript_path: "/tmp/s.jsonl" }) as HookPayload,
    awaitStop: async () => ({ reason: "turn-end" }) as HookPayload,
  };
  return {
    sessionGate: gate,
    tmux: {
      async newSession() {},
      async sendText() {},
      async sendEnter() {},
      async killSession() {},
    },
    stateIssue: {
      async readBody() {
        return validBody();
      },
    },
    gatherContext: () => STUB_CONTEXT,
    surfaceProblem: async () => {},
    ...extra,
  };
}

function baseOptions(
  dbPath: string,
  overrides: RecommenderRunOverrides,
): DispatchRecommenderOptions {
  return {
    repoPath,
    repoSlug: "thejustinwalsh/middle",
    stateIssue: 99,
    adapterName: "claude",
    getAdapter: stubAdapter,
    dbPath,
    worktreeRoot: join(scratch, "worktrees"),
    dispatcherPort: 0,
    schemaPath: "/abs/schemas/state-issue.v1.md",
    slots: { adapters: ["claude"], maxPerAdapter: { claude: 2 }, repoMax: 2, globalMax: 4 },
    runConfig: { defaultAdapter: "claude", autoDispatch: false, prMode: "worktree" },
    overrides,
  };
}

describe("dispatchRecommender — enqueues a recommender workflow (read-only)", () => {
  test("runs to completion and records a kind:'recommender' workflow row for the repo", async () => {
    const dbPath = join(scratch, "db.sqlite3");
    const result = await dispatchRecommender(baseOptions(dbPath, makeOverrides()));

    expect(result.state).toBe("completed");
    // Reopen the db the run wrote to and assert the enqueued workflow's identity.
    const db = openAndMigrate(dbPath);
    try {
      const row = db
        .query("SELECT kind, repo, epic_number, state FROM workflows WHERE id = ?")
        .get(result.workflowId) as {
        kind: string;
        repo: string;
        epic_number: number | null;
        state: string;
      };
      expect(row.kind).toBe("recommender");
      expect(row.repo).toBe("thejustinwalsh/middle");
      expect(row.epic_number).toBeNull();
      expect(row.state).toBe("completed");
    } finally {
      db.close();
    }
  });

  test("is read-only: a clean run never auto-dispatches (triggerAutoDispatch stays unwired)", async () => {
    // The override bag has no triggerAutoDispatch seam, and dispatchRecommender
    // never wires one — so even with autoDispatch true in config, nothing dispatches.
    const dbPath = join(scratch, "db.sqlite3");
    const opts = baseOptions(dbPath, makeOverrides());
    opts.runConfig.autoDispatch = true;
    const result = await dispatchRecommender(opts);
    expect(result.state).toBe("completed");
    // No second (implementation) workflow row was ever created.
    const db = openAndMigrate(dbPath);
    try {
      const rows = db.query("SELECT kind FROM workflows").all() as { kind: string }[];
      expect(rows).toEqual([{ kind: "recommender" }]);
    } finally {
      db.close();
    }
  });
});
