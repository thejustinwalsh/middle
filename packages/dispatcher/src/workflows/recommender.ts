import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { AgentAdapter, RepoConfig } from "@middle/core";
import { isParseError, parseStateIssue, validate } from "@middle/state-issue";
import type { RateLimits } from "@middle/state-issue";
import { Workflow } from "bunqueue/workflow";
import type { StepContext } from "bunqueue/workflow";
import type { SessionGate } from "../hook-server.ts";
import { getRateLimitState } from "../rate-limits.ts";
import type { RateLimitState } from "../rate-limits.ts";
import {
  countActiveImplementationSlots,
  createWorkflowRecord,
  listActiveImplementationWorkflows,
  updateWorkflow,
} from "../workflow-record.ts";
import type { CreateWorktreeOpts, WorktreeHandle } from "../worktree.ts";
import type { TmuxOps, WorktreeOps } from "./implementation.ts";

/** A recommender run: rewrite one repo's state issue with a ranked dispatch plan. */
export type RecommenderInput = {
  /** `owner/name` — the repo whose state issue is rewritten. */
  repo: string;
  /** The state issue number to rewrite. */
  stateIssue: number;
  /** Adapter to run the recommender agent with. */
  adapter: string;
};

/** The `config` block injected into the recommender prompt (skill "Phase 1"). */
export type RecommenderRunConfig = {
  defaultAdapter: string;
  /** Phase 7 is read-only: this is reported to the recommender but never acted on yet. */
  autoDispatch: boolean;
  prMode: string;
};

/** One currently-running agent, as the recommender's `in_flight` array reports it. */
export type InFlightSummary = {
  /** The Epic/issue number, or null for a non-issue workflow. */
  issue: number | null;
  adapter: string;
  /** "sub-issue m/n" or "running". */
  progress: string;
  /** The tmux session name, or null if not yet launched. */
  session: string | null;
};

/** Slot capacity as the recommender's `slots` object reports it. */
export type SlotsView = {
  perAdapter: Record<string, { used: number; max: number }>;
  total: { used: number; max: number; globalUsed: number; globalMax: number };
};

/**
 * The dispatcher-owned context the recommender consumes verbatim — rate limits,
 * in-flight agents, slot capacity. The recommender does NOT recompute these; the
 * dispatcher is their single source of truth (skill "Phase 1 — Receive context").
 */
export type RecommenderContext = {
  rateLimits: RateLimits;
  inFlight: InFlightSummary[];
  slots: SlotsView;
};

/** Reads a repo's state issue body (for `prior_body` and the verify step). */
export type StateIssueReader = {
  readBody(repo: string, issueNumber: number): Promise<string>;
};

/** Everything the recommender workflow needs that is not part of its per-run input. */
export type RecommenderDeps = {
  db: Database;
  getAdapter: (name: string) => AgentAdapter;
  sessionGate: SessionGate;
  tmux: TmuxOps;
  worktree: WorktreeOps;
  resolveRepoPath: (repo: string) => string;
  worktreeRoot: string;
  dispatcherUrl: string;
  /** On-disk path to `state-issue.v1.md` the recommender is pointed at. */
  schemaPath: string;
  /** Reads the state issue body — `prior_body` for the prompt, and the produced body to verify. */
  stateIssue: StateIssueReader;
  /** Configured adapter names, for `validate()` in the verify step. */
  repoConfig: RepoConfig;
  /** The `config` block reported to the recommender. */
  config: RecommenderRunConfig;
  /**
   * Gather the dispatcher-owned context (rate limits, in-flight, slots) verbatim.
   * Injected so tests stub it and the runner wires the real db/config-backed
   * derivation; the recommender never recomputes these itself.
   */
  gatherContext: (repo: string) => RecommenderContext;
  launchTimeoutMs?: number;
  /** Hard cap on the agent run — the spec's 5-minute ceiling. */
  agentTimeoutMs?: number;
  /**
   * Surface a malformed produced body to a human (the verify step's failure
   * path). Optional + injectable so tests need no `gh`.
   */
  surfaceProblem?: (opts: { repo: string; stateIssue: number; problem: string }) => Promise<void>;
  /**
   * The auto-dispatch seam (Phase 8). Phase 7 is read-only, so the runner leaves
   * this UNWIRED — `trigger-auto-dispatch` then dispatches nothing by construction.
   */
  triggerAutoDispatch?: (opts: { repo: string; stateIssue: number }) => Promise<void>;
};

const DEFAULT_LAUNCH_TIMEOUT_MS = 90_000;
const DEFAULT_AGENT_TIMEOUT_MS = 5 * 60 * 1000; // the spec's 5-minute hard cap

/**
 * Deterministic, repo-namespaced session name for the recommender's dedicated
 * slot. The readable slug is lossy — separator-replacement collapses distinct
 * repos onto the same string (`a/b` and `a-b`, or two repos differing only in a
 * stripped character) — so a short hash of the *raw* `repo` disambiguates. The
 * session name is the key for `killSession`/`sendText`; a collision would let
 * two repos' recommender runs corrupt each other's tmux lifecycle. Exported so
 * the collision-resistance is unit-testable.
 */
export function sessionNameFor(input: RecommenderInput): string {
  const repoSlug = input.repo.replace(/[^A-Za-z0-9_-]/g, "-");
  const hash = Bun.hash(input.repo).toString(16).slice(0, 8);
  return `middle-rec-${repoSlug}-${hash}`;
}

/**
 * Assemble the recommender prompt from all eight inputs the skill's
 * "Phase 1 — Receive context" enumerates. The dispatcher-owned context
 * (`rate_limits`, `in_flight`, `slots`) is embedded VERBATIM — serialized
 * straight from `ctx`, never recomputed — and the recommender is pointed at the
 * on-disk `schema_path`. Pure so it is unit-testable without the engine.
 */
export function assembleRecommenderPrompt(parts: {
  repo: string;
  stateIssue: number;
  schemaPath: string;
  priorBody: string;
  context: RecommenderContext;
  config: RecommenderRunConfig;
}): string {
  const { repo, stateIssue, schemaPath, priorBody, context, config } = parts;
  const json = (value: unknown): string => JSON.stringify(value, null, 2);
  // Render slots in the skill's documented "Phase 1" shape: per-adapter entries
  // at the top level keyed by adapter, `total` a sibling with snake_case globals.
  const slotsForPrompt = {
    ...context.slots.perAdapter,
    total: {
      used: context.slots.total.used,
      max: context.slots.total.max,
      global_used: context.slots.total.globalUsed,
      global_max: context.slots.total.globalMax,
    },
  };
  return `# Recommender run — dispatcher context

You are the dispatch recommender. Rewrite the state issue body following the
\`recommending-github-issues\` skill. The dispatcher provides everything below;
read all of it before any \`gh\` calls.

- \`repo\`: ${repo}
- \`state_issue\`: ${stateIssue}
- \`schema_path\`: ${schemaPath}

## config
\`\`\`json
${json({
  default_adapter: config.defaultAdapter,
  auto_dispatch: config.autoDispatch,
  pr_mode: config.prMode,
})}
\`\`\`

## rate_limits
\`\`\`json
${json(context.rateLimits)}
\`\`\`

## in_flight
\`\`\`json
${json(context.inFlight)}
\`\`\`

## slots
\`\`\`json
${json(slotsForPrompt)}
\`\`\`

## prior_body
The current contents of state issue #${stateIssue}, between the markers below.
The In-flight, Rate limits, and Slot usage sections above are dispatcher-owned —
copy them through verbatim, do not recompute them.

<<<PRIOR_BODY
${priorBody}
PRIOR_BODY
`;
}

/** Render an adapter's rate-limit row into the human-readable status string the
 * state issue's "Rate limits" section uses. Unknown (never observed) → UNKNOWN. */
function rateLimitStatus(state: RateLimitState | null): string {
  if (!state || state.status === "UNKNOWN") return "UNKNOWN";
  if (state.status === "AVAILABLE") return "AVAILABLE";
  // RATE_LIMITED — annotate with the reset time when known.
  return state.resetAt
    ? `RATE_LIMITED until ${new Date(state.resetAt).toISOString()}`
    : "RATE_LIMITED";
}

/**
 * Derive the dispatcher-owned context (rate limits, in-flight, slots) from
 * dispatcher state — the single source of truth the recommender consumes
 * verbatim. The runner wires this as the workflow's `gatherContext`; the
 * recommender never recomputes any of it (skill "Phase 1 — Receive context").
 */
export function buildRecommenderContext(opts: {
  db: Database;
  /** The repo whose state issue is being rewritten — scopes per-repo slots/in-flight. */
  repo: string;
  /** Configured adapter names — drives the per-adapter slot rows. */
  adapters: string[];
  /** Per-adapter concurrency cap (repo `limits.max_concurrent_per_adapter`). */
  maxPerAdapter: Record<string, number>;
  /** Repo-level total cap (`limits.max_concurrent`). */
  repoMax: number;
  /** Global cap (`global.max_concurrent`). */
  globalMax: number;
  /** The dispatcher's GitHub rate-limit read, if any (e.g. "4180/5000"). */
  githubStatus?: string;
}): RecommenderContext {
  // Per-repo used (drives perAdapter + total); global used spans all repos on the
  // shared db (drives global_used) — the two are distinct in the schema.
  const used = countActiveImplementationSlots(opts.db, opts.repo);
  const globalUsed = countActiveImplementationSlots(opts.db).total;
  const perAdapter: Record<string, { used: number; max: number }> = {};
  for (const adapter of opts.adapters) {
    perAdapter[adapter] = {
      used: used.perAdapter[adapter] ?? 0,
      max: opts.maxPerAdapter[adapter] ?? 0,
    };
  }
  return {
    rateLimits: {
      claude: rateLimitStatus(getRateLimitState(opts.db, "claude")),
      codex: rateLimitStatus(getRateLimitState(opts.db, "codex")),
      github: opts.githubStatus ?? "UNKNOWN",
    },
    inFlight: listActiveImplementationWorkflows(opts.db, opts.repo).map((w) => ({
      issue: w.epicNumber,
      adapter: w.adapter,
      progress: w.state === "running" ? "running" : w.state,
      session: w.sessionName,
    })),
    slots: {
      perAdapter,
      total: { used: used.total, max: opts.repoMax, globalUsed, globalMax: opts.globalMax },
    },
  };
}

type PrepareResult = { handle: WorktreeHandle };
type BuildPromptResult = { priorBody: string; promptText: string };
type VerifyResult = { ok: boolean; errors: string[] };

/**
 * The `recommender` workflow (build spec → "bunqueue workflows" →
 * "recommender workflow"):
 *
 *   check-rate-limit → prepare-shallow-worktree → build-prompt
 *     → spawn-recommender-agent (5-min hard cap) → verify-state-issue-parses
 *     → trigger-auto-dispatch → cleanup-worktree
 *
 * Linear (no park/resume — the recommender is a short one-shot). The recommender
 * records its `workflows` row with `kind:"recommender"`, so it runs on its own
 * dedicated slot and is never counted against `maxConcurrent`. Built as a factory
 * so the dispatcher injects real collaborators and tests inject stubs.
 */
export function createRecommenderWorkflow(deps: RecommenderDeps): Workflow<RecommenderInput> {
  const launchTimeout = deps.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  const agentTimeout = deps.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;

  /** Tear down the worktree + session. Both the final step and the prepare
   * compensation route here; idempotent so running it twice is safe. */
  async function teardown(ctx: StepContext<RecommenderInput>): Promise<void> {
    const prepared = ctx.steps["prepare-shallow-worktree"] as PrepareResult | undefined;
    if (!prepared?.handle) return;
    await deps.tmux.killSession(sessionNameFor(ctx.input));
    await deps.worktree.destroyWorktree(prepared.handle);
  }

  async function checkRateLimit(ctx: StepContext<RecommenderInput>): Promise<void> {
    createWorkflowRecord(deps.db, {
      id: ctx.executionId,
      kind: "recommender",
      repo: ctx.input.repo,
      epicNumber: null,
      adapter: ctx.input.adapter,
    });
    const state = getRateLimitState(deps.db, ctx.input.adapter);
    const stillLimited =
      state?.status === "RATE_LIMITED" && (state.resetAt === null || state.resetAt > Date.now());
    if (stillLimited) {
      updateWorkflow(deps.db, ctx.executionId, { state: "rate-limited" });
      throw new Error(`recommender adapter ${ctx.input.adapter} is rate-limited`);
    }
  }

  async function prepareShallowWorktree(
    ctx: StepContext<RecommenderInput>,
  ): Promise<PrepareResult> {
    const opts: CreateWorktreeOpts = {
      repoPath: deps.resolveRepoPath(ctx.input.repo),
      repo: ctx.input.repo,
      // issueNumber omitted → the worktree helper uses the "recommender" unit.
      worktreeRoot: deps.worktreeRoot,
    };
    const handle = await deps.worktree.createWorktree(opts);
    updateWorkflow(deps.db, ctx.executionId, { worktreePath: handle.path });
    return { handle };
  }

  /** Compensation for prepare-shallow-worktree: roll the worktree back, free the session. */
  async function cleanupWorktreeCompensation(ctx: StepContext<RecommenderInput>): Promise<void> {
    await teardown(ctx);
    updateWorkflow(deps.db, ctx.executionId, { state: "compensated" });
  }

  async function buildPrompt(ctx: StepContext<RecommenderInput>): Promise<BuildPromptResult> {
    const { handle } = ctx.steps["prepare-shallow-worktree"] as PrepareResult;
    const priorBody = await deps.stateIssue.readBody(ctx.input.repo, ctx.input.stateIssue);
    const context = deps.gatherContext(ctx.input.repo);
    const promptText = assembleRecommenderPrompt({
      repo: ctx.input.repo,
      stateIssue: ctx.input.stateIssue,
      schemaPath: deps.schemaPath,
      priorBody,
      context,
      config: deps.config,
    });
    // The launch references `.middle/prompt.md`; write the assembled context there.
    const middleDir = join(handle.path, ".middle");
    mkdirSync(middleDir, { recursive: true });
    writeFileSync(join(middleDir, "prompt.md"), promptText);
    return { priorBody, promptText };
  }

  async function spawnRecommenderAgent(ctx: StepContext<RecommenderInput>): Promise<void> {
    const { handle } = ctx.steps["prepare-shallow-worktree"] as PrepareResult;
    const adapter = deps.getAdapter(ctx.input.adapter);
    const sessionName = sessionNameFor(ctx.input);
    const sessionToken = crypto.randomUUID();
    const tag = `[recommender:${sessionName}]`;

    updateWorkflow(deps.db, ctx.executionId, { state: "launching", sessionName, sessionToken });
    try {
      await adapter.installHooks({
        worktree: handle.path,
        hookScriptPath: ".middle/hooks/hook.sh",
        dispatcherUrl: deps.dispatcherUrl,
        sessionName,
        sessionToken,
        epicNumber: ctx.input.stateIssue,
      });
      const { argv, env } = adapter.buildLaunchCommand({
        worktree: handle.path,
        sessionName,
        sessionToken,
        envOverrides: { MIDDLE_DISPATCHER_URL: deps.dispatcherUrl },
      });
      // Clear any orphaned session of the same name before launching.
      await deps.tmux.killSession(sessionName);
      await deps.tmux.newSession({ sessionName, command: argv, cwd: handle.path, env });

      const dismissPromise = adapter.enterAutoMode({ sessionName }).catch((err: unknown) => {
        console.error(`${tag} enterAutoMode failed: ${(err as Error).message}`);
      });
      await deps.sessionGate.awaitSessionStart(sessionName, launchTimeout);
      void dismissPromise;

      updateWorkflow(deps.db, ctx.executionId, { state: "running" });
      const promptText = adapter.buildPromptText({
        promptFile: ".middle/prompt.md",
        kind: "recommender",
      });
      await deps.tmux.sendText(sessionName, promptText);
      await deps.tmux.sendEnter(sessionName);

      // The recommender is a one-shot: drive one turn, observe the Stop. The
      // step's own `timeout` (5 min) is the hard cap; this Stop-await is bounded
      // just under it so it surfaces a specific error rather than the step timeout.
      await deps.sessionGate.awaitStop(sessionName, agentTimeout);
      // END SESSION — the turn is over; free the dedicated slot.
      await deps.tmux.killSession(sessionName);
    } catch (error) {
      console.error(`${tag} spawn failed: ${(error as Error).message}`);
      await deps.tmux.killSession(sessionName);
      throw error;
    }
  }

  async function verifyStateIssueParses(ctx: StepContext<RecommenderInput>): Promise<VerifyResult> {
    const body = await deps.stateIssue.readBody(ctx.input.repo, ctx.input.stateIssue);
    const parsed = parseStateIssue(body);
    if (isParseError(parsed)) {
      const problem = `state issue #${ctx.input.stateIssue} does not parse: ${parsed.message}`;
      await surface(ctx, problem);
      return { ok: false, errors: [parsed.message] };
    }
    const result = validate(parsed, deps.repoConfig);
    if (!result.ok) {
      const problem = `state issue #${ctx.input.stateIssue} failed validation: ${result.errors.join("; ")}`;
      await surface(ctx, problem);
      return { ok: false, errors: [...result.errors] };
    }
    return { ok: true, errors: [] };
  }

  async function surface(ctx: StepContext<RecommenderInput>, problem: string): Promise<void> {
    console.error(`[recommender] ${problem}`);
    if (!deps.surfaceProblem) return;
    try {
      await deps.surfaceProblem({
        repo: ctx.input.repo,
        stateIssue: ctx.input.stateIssue,
        problem,
      });
    } catch (error) {
      // Surfacing is best-effort — a failed comment must not abort cleanup.
      console.error(`[recommender] surfaceProblem failed: ${(error as Error).message}`);
    }
  }

  async function triggerAutoDispatch(ctx: StepContext<RecommenderInput>): Promise<void> {
    const verify = ctx.steps["verify-state-issue-parses"] as VerifyResult;
    // Gate on a clean parse. Phase 7 is read-only: the runner leaves
    // `triggerAutoDispatch` unwired, so nothing dispatches regardless of config.
    if (!verify.ok || !deps.config.autoDispatch || !deps.triggerAutoDispatch) return;
    await deps.triggerAutoDispatch({ repo: ctx.input.repo, stateIssue: ctx.input.stateIssue });
  }

  async function cleanupWorktree(ctx: StepContext<RecommenderInput>): Promise<void> {
    await teardown(ctx);
    // A malformed produced body is a failed run, not a silent success — the
    // verify step already surfaced it and gated auto-dispatch; reflect it in the
    // terminal state so the bad output isn't masked as "completed".
    const verify = ctx.steps["verify-state-issue-parses"] as VerifyResult | undefined;
    const finalState = verify && !verify.ok ? "failed" : "completed";
    updateWorkflow(deps.db, ctx.executionId, { state: finalState });
  }

  return (
    new Workflow<RecommenderInput>("recommender")
      // retry: 1 — the check is deterministic (reads db state), so retrying is
      // pointless; and it creates the workflows row then throws on the
      // rate-limited path, so a retry would re-run the INSERT and surface a UNIQUE
      // violation instead of the real rate-limit reason. One attempt, no retry.
      .step("check-rate-limit", checkRateLimit, { retry: 1 })
      .step("prepare-shallow-worktree", prepareShallowWorktree, {
        compensate: cleanupWorktreeCompensation,
      })
      .step("build-prompt", buildPrompt)
      .step("spawn-recommender-agent", spawnRecommenderAgent, {
        retry: 1,
        // The spec's hard cap; widened slightly above the internal Stop-await so the
        // internal timeout (specific error) fires first in the normal case.
        timeout: launchTimeout + agentTimeout + 30_000,
      })
      .step("verify-state-issue-parses", verifyStateIssueParses)
      .step("trigger-auto-dispatch", triggerAutoDispatch)
      .step("cleanup-worktree", cleanupWorktree)
  );
}
