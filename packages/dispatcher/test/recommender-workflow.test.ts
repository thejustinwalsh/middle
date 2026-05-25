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
import {
  countActiveImplementationSlots,
  createWorkflowRecord,
  getWorkflow,
  updateWorkflow,
} from "../src/workflow-record.ts";
import {
  assembleRecommenderPrompt,
  buildRecommenderContext,
  createRecommenderWorkflow,
  type RecommenderContext,
  type RecommenderDeps,
  type RecommenderInput,
  sessionNameFor,
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
    readTranscriptState: () => ({
      lastActivity: "",
      contextTokens: 0,
      turnCount: 0,
      lastToolUse: null,
    }),
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
    config: {
      defaultAdapter: "claude",
      autoDispatch: opts?.autoDispatch ?? false,
      prMode: "worktree",
    },
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
  throw new Error(
    `recommender ${handle.id} did not settle (exec '${engine.getExecution(handle.id)?.state}')`,
  );
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

  test("spawn-recommender-agent uses the default 15-minute hard cap", () => {
    // The step `timeout` is the hard cap; assert it via the built workflow's
    // step config rather than wall-clock. Defaults: 90s launch + 15min agent
    // (bumped from 5min, which was too tight against a real repo).
    const h = makeHarness();
    delete (h.deps as { agentTimeoutMs?: number }).agentTimeoutMs;
    delete (h.deps as { launchTimeoutMs?: number }).launchTimeoutMs;
    const def = stepDef(h.deps, "spawn-recommender-agent");
    expect(def).toBeDefined();
    // launch (90s) + agent (15min) + 30s backstop, per the factory.
    expect(def!.timeout).toBe(90_000 + 15 * 60 * 1000 + 30_000);
  });

  test("prepare-shallow-worktree registers a compensation handler", () => {
    expect(stepDef(makeHarness().deps, "prepare-shallow-worktree")!.compensate).toBeDefined();
  });

  test("check-rate-limit does not retry — it creates the row then may throw, and a retry would re-INSERT", () => {
    // retry: 1 means one attempt, no retries (see the factory comment). Guards
    // against a retried step re-running createWorkflowRecord → UNIQUE violation
    // that would mask the real rate-limit reason.
    expect(stepDef(makeHarness().deps, "check-rate-limit")!.retry).toBe(1);
  });

  test("a rate-limited adapter fails the run with state 'rate-limited' (not a UNIQUE error)", async () => {
    setRateLimited(db, {
      adapter: "stub",
      resetAt: Date.parse("2099-01-01T00:00:00Z"), // far future → still limited
      source: "transcript",
    });
    const h = makeHarness();
    engine.register(createRecommenderWorkflow(h.deps));
    const handle = await engine.start("recommender", INPUT);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const s = engine.getExecution(handle.id)?.state;
      if (s === "failed" || s === "completed") break;
      await Bun.sleep(15);
    }
    expect(engine.getExecution(handle.id)?.state).toBe("failed");
    // The row state was set to rate-limited before the throw; no second attempt
    // re-ran the INSERT (retry: 1), so it isn't a masked UNIQUE failure.
    expect(getWorkflow(db, handle.id)!.state).toBe("rate-limited");
    // Never advanced past the first step — no worktree was created.
    expect(await listWorktrees({ repoPath, worktreeRoot })).toEqual([]);
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

describe("recommender workflow — #44 build-prompt: every required input, verbatim", () => {
  const PRIOR = "## Ready to dispatch\n\nprior body sentinel 4f2a\n";

  test("assembles all eight Phase-1 inputs, with dispatcher-owned context verbatim", () => {
    const prompt = assembleRecommenderPrompt({
      repo: REPO,
      stateIssue: STATE_ISSUE,
      schemaPath: "/abs/schemas/state-issue.v1.md",
      priorBody: PRIOR,
      context: SAMPLE_CONTEXT,
      config: { defaultAdapter: "claude", autoDispatch: false, prMode: "worktree" },
    });

    // repo, state_issue, schema_path
    expect(prompt).toContain(REPO);
    expect(prompt).toContain(`state_issue\`: ${STATE_ISSUE}`);
    expect(prompt).toContain("/abs/schemas/state-issue.v1.md");
    // prior_body (verbatim, sentinel survives)
    expect(prompt).toContain("prior body sentinel 4f2a");
    // config
    expect(prompt).toContain('"default_adapter": "claude"');
    expect(prompt).toContain('"auto_dispatch": false');
    expect(prompt).toContain('"pr_mode": "worktree"');
    // rate_limits — verbatim from dispatcher state
    expect(prompt).toContain('"codex": "RATE_LIMITED until 16:32Z"');
    expect(prompt).toContain('"github": "4180/5000"');
    // in_flight — verbatim
    expect(prompt).toContain('"session": "middle-x-6"');
    expect(prompt).toContain('"progress": "sub-issue 2/5"');
    // slots — rendered in the skill's documented Phase-1 shape (per-adapter at top
    // level keyed by adapter; total a sibling with snake_case globals).
    expect(prompt).toContain('"global_max": 4');
    expect(prompt).toContain('"global_used": 2');
    expect(prompt).toMatch(/"claude":\s*\{\s*"used": 1,\s*"max": 2\s*\}/);
  });

  test("writes the assembled prompt to .middle/prompt.md and launches it via the @-reference", async () => {
    const h = makeHarness({ bodies: [PRIOR, validBody()] });
    h.deps.schemaPath = "/somewhere/state-issue.v1.md";
    // Capture the on-disk prompt just before the cleanup step tears the worktree down.
    let writtenPrompt = "";
    const realDestroy = h.deps.worktree.destroyWorktree;
    h.deps.worktree.destroyWorktree = async (handle) => {
      const p = join(handle.path, ".middle", "prompt.md");
      if (existsSync(p)) writtenPrompt = readFileSync(p, "utf8");
      return realDestroy(handle);
    };

    const id = await runToEnd(h.deps);
    expect(getWorkflow(db, id)!.state).toBe("completed");

    // The build-prompt step wrote the full assembled prompt to .middle/prompt.md…
    expect(writtenPrompt).toContain("/somewhere/state-issue.v1.md"); // schema_path on disk
    expect(writtenPrompt).toContain("prior body sentinel 4f2a"); // prior_body verbatim
    expect(writtenPrompt).toContain('"github": "4180/5000"'); // dispatcher-owned context verbatim
    // …and the launch referenced that file (not an inline prompt — multi-line context).
    expect(h.sent.some((t) => t === "/recommending-github-issues @.middle/prompt.md")).toBe(true);
    // gatherContext called exactly once (no recompute); prior_body read before gather.
    expect(h.trace.filter((t) => t === "build-prompt:gather")).toHaveLength(1);
    expect(h.trace.indexOf("build-prompt:read-prior")).toBeLessThan(
      h.trace.indexOf("build-prompt:gather"),
    );
  });
});

/** A body that parses but fails validation: a Ready row using an unconfigured adapter. */
function bodyWithUnconfiguredAdapter(): string {
  return renderStateIssue({
    version: 1,
    generated: new Date().toISOString(),
    runId: "00000000",
    intervalMinutes: 15,
    readyToDispatch: [
      { rank: 1, epic: "#6 Some epic", adapter: "ghost", subIssues: 2, reason: "ready" },
    ],
    needsHumanInput: [],
    blocked: [],
    inFlight: [],
    excluded: [],
    rateLimits: { claude: "AVAILABLE", codex: "UNKNOWN", github: "UNKNOWN" },
    slotUsage: { adapters: [], total: { used: 0, max: 0 }, global: { used: 0, max: 0 } },
  });
}

describe("recommender workflow — #45 verify-state-issue-parses: gate auto-dispatch", () => {
  test("a valid produced body verifies ok and the workflow proceeds to trigger-auto-dispatch", async () => {
    const h = makeHarness({
      bodies: [validBody(), validBody()],
      autoDispatch: true,
      wireTrigger: true,
    });
    const id = await runToEnd(h.deps);

    expect(getWorkflow(db, id)!.state).toBe("completed");
    expect(h.triggered).toEqual([{ repo: REPO, stateIssue: STATE_ISSUE }]); // proceeded
    expect(h.surfaced).toEqual([]); // nothing surfaced
  });

  test("a malformed produced body does NOT proceed to auto-dispatch and surfaces the problem", async () => {
    // Second readBody (the verify read) returns garbage that won't parse.
    const h = makeHarness({
      bodies: [validBody(), "not a state issue body"],
      autoDispatch: true,
      wireTrigger: true,
    });
    const id = await runToEnd(h.deps);

    // Failed run (bad output not masked as completed), no dispatch, surfaced, worktree cleaned.
    expect(getWorkflow(db, id)!.state).toBe("failed");
    expect(h.triggered).toEqual([]);
    expect(h.surfaced).toHaveLength(1);
    expect(h.surfaced[0]).toContain("does not parse");
    expect(await listWorktrees({ repoPath, worktreeRoot })).toEqual([]);
    expect(h.trace).not.toContain("trigger");
  });

  test("a body that parses but fails validation is also gated and surfaced", async () => {
    const h = makeHarness({
      bodies: [validBody(), bodyWithUnconfiguredAdapter()],
      autoDispatch: true,
      wireTrigger: true,
    });
    const id = await runToEnd(h.deps);

    expect(getWorkflow(db, id)!.state).toBe("failed");
    expect(h.triggered).toEqual([]);
    expect(h.surfaced).toHaveLength(1);
    expect(h.surfaced[0]).toContain("failed validation");
    expect(h.surfaced[0]).toContain("ghost"); // names the offending adapter
  });

  test("a failed surfaceProblem callback does not abort cleanup (best-effort surfacing)", async () => {
    const h = makeHarness({
      bodies: [validBody(), "garbage"],
      autoDispatch: true,
      wireTrigger: true,
    });
    h.deps.surfaceProblem = async () => {
      throw new Error("gh comment failed");
    };
    const id = await runToEnd(h.deps);

    expect(getWorkflow(db, id)!.state).toBe("failed");
    expect(await listWorktrees({ repoPath, worktreeRoot })).toEqual([]); // still cleaned up
  });
});

describe("recommender workflow — #44 buildRecommenderContext: from dispatcher state", () => {
  const mk = (
    id: string,
    adapter: string,
    epic: number | null,
    session: string,
    state?: string,
  ) => {
    createWorkflowRecord(db, { id, kind: "implementation", repo: REPO, epicNumber: epic, adapter });
    updateWorkflow(db, id, { sessionName: session, state: (state ?? "running") as never });
  };

  test("derives rate_limits, in_flight, and slots from db + config", () => {
    mk("a", "claude", 6, "middle-x-6");
    mk("b", "claude", 7, "middle-x-7");
    setRateLimited(db, {
      adapter: "codex",
      resetAt: Date.parse("2026-05-24T16:32:00Z"),
      source: "transcript",
    });

    const ctx = buildRecommenderContext({
      db,
      repo: REPO,
      adapters: ["claude", "codex"],
      maxPerAdapter: { claude: 2, codex: 1 },
      repoMax: 3,
      globalMax: 4,
      githubStatus: "4180/5000",
    });

    expect(ctx.rateLimits.claude).toBe("UNKNOWN");
    expect(ctx.rateLimits.codex).toContain("RATE_LIMITED until 2026-05-24T16:32:00");
    expect(ctx.rateLimits.github).toBe("4180/5000");
    expect(ctx.inFlight).toEqual([
      { issue: 6, adapter: "claude", progress: "running", session: "middle-x-6" },
      { issue: 7, adapter: "claude", progress: "running", session: "middle-x-7" },
    ]);
    expect(ctx.slots).toEqual({
      perAdapter: { claude: { used: 2, max: 2 }, codex: { used: 0, max: 1 } },
      total: { used: 2, max: 3, globalUsed: 2, globalMax: 4 },
    });
  });

  test("excludes the recommender's own row from in_flight and slots", () => {
    createWorkflowRecord(db, {
      id: "rec",
      kind: "recommender",
      repo: REPO,
      epicNumber: null,
      adapter: "claude",
    });
    updateWorkflow(db, "rec", { state: "running" });
    const ctx = buildRecommenderContext({
      db,
      repo: REPO,
      adapters: ["claude"],
      maxPerAdapter: { claude: 2 },
      repoMax: 2,
      globalMax: 4,
    });
    expect(ctx.inFlight).toEqual([]);
    expect(ctx.slots.total.used).toBe(0);
    expect(ctx.rateLimits.github).toBe("UNKNOWN");
  });

  test("scopes per-repo slots/in_flight to the repo, but global_used spans all repos", () => {
    mk("a", "claude", 6, "middle-x-6"); // REPO
    createWorkflowRecord(db, {
      id: "b",
      kind: "implementation",
      repo: "other/repo",
      epicNumber: 9,
      adapter: "claude",
    });
    updateWorkflow(db, "b", { sessionName: "other-9", state: "running" as never });

    const ctx = buildRecommenderContext({
      db,
      repo: REPO,
      adapters: ["claude"],
      maxPerAdapter: { claude: 2 },
      repoMax: 2,
      globalMax: 4,
    });
    // Per-repo: only REPO's one agent counts toward used / in_flight.
    expect(ctx.slots.perAdapter.claude).toEqual({ used: 1, max: 2 });
    expect(ctx.slots.total.used).toBe(1);
    expect(ctx.inFlight.map((w) => w.issue)).toEqual([6]);
    // Global: both repos' agents count toward global_used (shared db).
    expect(ctx.slots.total.globalUsed).toBe(2);
    expect(ctx.slots.total.globalMax).toBe(4);
  });
});

describe("recommender workflow — sessionNameFor collision-resistance", () => {
  const name = (repo: string) => sessionNameFor({ repo, stateIssue: 1, adapter: "claude" });

  test("is deterministic for a given repo", () => {
    expect(name("thejustinwalsh/middle")).toBe(name("thejustinwalsh/middle"));
  });

  test("produces a tmux-safe session name (no separators survive)", () => {
    // Only the chars tmux tolerates in a session name; the hash is lowercase hex
    // (≤ 8 chars — a leading-zero value can be shorter, which is still unique).
    expect(name("the.just/in walsh/middle")).toMatch(/^middle-rec-[A-Za-z0-9_-]+-[0-9a-f]{1,8}$/);
  });

  test("distinct repos that share a lossy slug do not collide", () => {
    // Both slug to `a-b` once separators are replaced; the raw-repo hash splits them.
    expect(name("a/b")).not.toBe(name("a-b"));
    // A stripped character must not erase the distinction either.
    expect(name("a/b")).not.toBe(name("a/b!"));
    expect(name("owner/repo")).not.toBe(name("owner/rep o"));
  });
});

describe("recommender workflow — daemon path (resolveRunSettings, #135 fix)", () => {
  // The bug this guards: the daemon used to fire the recommender on a *second*
  // ephemeral engine that never processed the job, so no `recommender` row was
  // ever created. The daemon now registers ONE workflow on its long-lived engine
  // and resolves per-repo settings via `resolveRunSettings`. This proves that
  // path actually RUNS: it creates the recommender row and drives to completion.
  test("runs on the engine via per-repo resolveRunSettings and creates the recommender row", async () => {
    const h = makeHarness({ autoDispatch: true, wireTrigger: true });
    const resolverCalls: string[] = [];
    const daemonDeps: RecommenderDeps = {
      ...h.deps,
      // The daemon omits the static settings and resolves them per-repo instead.
      schemaPath: undefined,
      config: undefined,
      repoConfig: undefined,
      resolveRunSettings: (repo) => {
        resolverCalls.push(repo);
        return {
          schemaPath: "/abs/schemas/state-issue.v1.md",
          config: { defaultAdapter: "claude", autoDispatch: true, prMode: "worktree" },
          repoConfig: REPO_CONFIG,
          agentTimeoutMs: 2000,
        };
      },
    };

    const id = await runToEnd(daemonDeps);

    const row = getWorkflow(db, id)!;
    expect(row.state).toBe("completed"); // it actually ran on the engine
    expect(row.kind).toBe("recommender"); // the row the old dead-engine path never created
    expect(resolverCalls).toContain(REPO); // per-repo resolver drove the run, not static deps
    // auto_dispatch came from the resolved per-repo config → the trigger fired.
    expect(h.triggered).toEqual([{ repo: REPO, stateIssue: STATE_ISSUE }]);
  });

  test("a clear wiring error when neither resolveRunSettings nor static settings are provided", async () => {
    const h = makeHarness();
    const broken: RecommenderDeps = {
      ...h.deps,
      schemaPath: undefined,
      config: undefined,
      repoConfig: undefined,
      // resolveRunSettings deliberately absent → the build-prompt guard throws.
    };
    const id = await runToEnd(broken);
    // The guard fails the run (and compensation rolls the worktree back) rather
    // than silently producing a half-run — exactly the failure mode we're fixing.
    expect(["failed", "compensated"]).toContain(getWorkflow(db, id)!.state);
  });
});
