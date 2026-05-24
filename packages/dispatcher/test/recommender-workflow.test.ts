import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, HookPayload, RepoConfig } from "@middle/core";
import { renderStateIssue } from "@middle/state-issue";
import { Engine } from "bunqueue/workflow";
import { openAndMigrate } from "../src/db.ts";
import type { SessionGate } from "../src/hook-server.ts";
import { setRateLimited } from "../src/rate-limits.ts";
import { getWorkflow, countActiveImplementationSlots } from "../src/workflow-record.ts";
import {
  assembleRecommenderPrompt,
  createRecommenderWorkflow,
  type RecommenderContext,
  type RecommenderDeps,
  type RecommenderInput,
} from "../src/workflows/recommender.ts";
import { createWorktree, destroyWorktree, listWorktrees } from "../src/worktree.ts";

let scratch: string;
let repoPath: string;
let worktreeRoot: string;
let db: Database;
let engine: Engine;

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
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "middle-rec-")));
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

const REPO = "thejustinwalsh/middle";
const STATE_ISSUE = 99;
const INPUT: RecommenderInput = { repo: REPO, stateIssue: STATE_ISSUE, adapter: "stub" };
const REPO_CONFIG: RepoConfig = { adapters: ["claude", "codex", "stub"] };

/** A schema-conforming state-issue body (every section at its documented empty state). */
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

const SAMPLE_CONTEXT: RecommenderContext = {
  rateLimits: { claude: "AVAILABLE", codex: "RATE_LIMITED until 16:32Z", github: "4180/5000" },
  inFlight: [{ issue: 6, adapter: "claude", progress: "sub-issue 2/5", session: "middle-x-6" }],
  slots: {
    perAdapter: { claude: { used: 1, max: 2 }, codex: { used: 0, max: 1 } },
    total: { used: 1, max: 3, globalUsed: 2, globalMax: 4 },
  },
};

/** Records every collaborator call into a shared trace, so step order is observable. */
function makeHarness(opts?: {
  bodies?: string[]; // readBody returns, in call order; last repeats
  context?: RecommenderContext;
  autoDispatch?: boolean;
  wireTrigger?: boolean;
  failSession?: boolean;
}) {
  const trace: string[] = [];
  const created: string[] = [];
  const killed: string[] = [];
  const sent: string[] = [];
  const triggered: Array<{ repo: string; stateIssue: number }> = [];
  const surfaced: string[] = [];
  const bodies = opts?.bodies ?? [validBody(), validBody()];
  let readCount = 0;

  const tmux = {
    async newSession(o: { sessionName: string }) {
      trace.push("spawn");
      created.push(o.sessionName);
    },
    async sendText(_s: string, text: string) {
      sent.push(text);
    },
    async sendEnter() {},
    async killSession(sessionName: string) {
      killed.push(sessionName);
    },
  };

  const adapter: AgentAdapter = {
    name: "stub",
    readyEvent: "session.started",
    async installHooks() {},
    buildLaunchCommand: () => ({ argv: ["true"], env: {} }),
    buildPromptText: (o) => `/recommending-github-issues @${o.promptFile}`,
    async enterAutoMode() {},
    resolveTranscriptPath: (p) => p.transcript_path as string,
    readTranscriptState: () => ({ lastActivity: "", contextTokens: 0, turnCount: 0, lastToolUse: null }),
    classifyStop: () => ({ kind: "done" }),
  };

  const gate: SessionGate = {
    awaitSessionStart: async () => {
      if (opts?.failSession) throw new Error("launch timeout");
      return { session_id: "s", transcript_path: "/tmp/s.jsonl" } as HookPayload;
    },
    awaitStop: async () => ({ reason: "turn-end" }) as HookPayload,
  };

  const deps: RecommenderDeps = {
    db,
    getAdapter: () => adapter,
    sessionGate: gate,
    tmux,
    worktree: {
      async createWorktree(o) {
        trace.push("prepare");
        return createWorktree(o);
      },
      async destroyWorktree(h) {
        trace.push("cleanup");
        return destroyWorktree(h);
      },
    },
    resolveRepoPath: () => repoPath,
    worktreeRoot,
    dispatcherUrl: "http://127.0.0.1:8822",
    schemaPath: "/abs/schemas/state-issue.v1.md",
    stateIssue: {
      async readBody() {
        trace.push(readCount === 0 ? "build-prompt:read-prior" : "verify:read");
        const body = bodies[Math.min(readCount, bodies.length - 1)]!;
        readCount += 1;
        return body;
      },
    },
    repoConfig: REPO_CONFIG,
    config: { defaultAdapter: "claude", autoDispatch: opts?.autoDispatch ?? false, prMode: "worktree" },
    gatherContext: () => {
      trace.push("build-prompt:gather");
      return opts?.context ?? SAMPLE_CONTEXT;
    },
    launchTimeoutMs: 2000,
    agentTimeoutMs: 2000,
    surfaceProblem: async (o) => {
      surfaced.push(o.problem);
    },
    triggerAutoDispatch: opts?.wireTrigger
      ? async (o) => {
          trace.push("trigger");
          triggered.push(o);
        }
      : undefined,
  };

  return { deps, trace, created, killed, sent, triggered, surfaced };
}

async function runToEnd(deps: RecommenderDeps, timeoutMs = 5000): Promise<string> {
  engine.register(createRecommenderWorkflow(deps));
  const handle = await engine.start("recommender", INPUT);
  const terminal = new Set(["completed", "failed", "compensated", "cancelled"]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = engine.getExecution(handle.id)?.state;
    if (s && terminal.has(s)) return handle.id;
    await Bun.sleep(15);
  }
  throw new Error(`recommender ${handle.id} did not settle (exec '${engine.getExecution(handle.id)?.state}')`);
}

/** The step node's definition (name/timeout/retry/compensate), or undefined. */
function stepDef(deps: RecommenderDeps, name: string) {
  const wf = createRecommenderWorkflow(deps);
  const node = wf.nodes.find((n) => n.type === "step" && n.def.name === name);
  return node && node.type === "step" ? node.def : undefined;
}

describe("recommender workflow — #43 shell: step order + dedicated slot", () => {
  test("declares the seven spec steps in order", () => {
    const wf = createRecommenderWorkflow(makeHarness().deps);
    expect(wf.getStepNames()).toEqual([
      "check-rate-limit",
      "prepare-shallow-worktree",
      "build-prompt",
      "spawn-recommender-agent",
      "verify-state-issue-parses",
      "trigger-auto-dispatch",
      "cleanup-worktree",
    ]);
  });

  test("runs the steps in spec order at runtime and completes", async () => {
    const h = makeHarness({ autoDispatch: true, wireTrigger: true });
    const id = await runToEnd(h.deps);

    expect(getWorkflow(db, id)!.state).toBe("completed");
    // Step order: prepare → build-prompt (read prior, gather) → spawn → verify → trigger → cleanup.
    expect(h.trace).toEqual([
      "prepare",
      "build-prompt:read-prior",
      "build-prompt:gather",
      "spawn",
      "verify:read",
      "trigger",
      "cleanup",
    ]);
    // The agent was launched with the recommender slash command.
    expect(h.sent.some((t) => t.startsWith("/recommending-github-issues"))).toBe(true);
    // No worktree or session leaked.
    expect(await listWorktrees({ repoPath, worktreeRoot })).toEqual([]);
    for (const s of new Set(h.created)) expect(h.killed).toContain(s);
  });

  test("records its row with kind 'recommender' — its own dedicated slot, off maxConcurrent", async () => {
    const h = makeHarness();
    const id = await runToEnd(h.deps);

    expect(getWorkflow(db, id)!.kind).toBe("recommender");
    expect(getWorkflow(db, id)!.epicNumber).toBeNull();
    // The recommender's own run never counts as a dispatch slot.
    expect(countActiveImplementationSlots(db)).toEqual({ total: 0, perAdapter: {} });
  });

  test("spawn-recommender-agent has the spec's 5-minute hard cap", () => {
    // The step `timeout` is the hard cap; assert it via the built workflow's
    // step config rather than wall-clock. Defaults: 90s launch + 5min agent.
    const h = makeHarness();
    delete (h.deps as { agentTimeoutMs?: number }).agentTimeoutMs;
    delete (h.deps as { launchTimeoutMs?: number }).launchTimeoutMs;
    const def = stepDef(h.deps, "spawn-recommender-agent");
    expect(def).toBeDefined();
    // launch (90s) + agent (5min) + 30s backstop, per the factory.
    expect(def!.timeout).toBe(90_000 + 5 * 60 * 1000 + 30_000);
  });

  test("prepare-shallow-worktree registers a compensation handler", () => {
    expect(stepDef(makeHarness().deps, "prepare-shallow-worktree")!.compensate).toBeDefined();
  });

  test("a launch failure compensates: worktree rolled back, session freed, state 'compensated'", async () => {
    const h = makeHarness({ failSession: true });
    const id = await runToEnd(h.deps);

    expect(getWorkflow(db, id)!.state).toBe("compensated");
    // Compensation tore the worktree down and freed the session.
    expect(await listWorktrees({ repoPath, worktreeRoot })).toEqual([]);
    for (const s of new Set(h.created)) expect(h.killed).toContain(s);
  });
});
