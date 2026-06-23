import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { AgentAdapter, EpicStoreSettings, RepoConfig } from "@middle/core";
import { isParseError, parseStateIssue, renderStateIssue, validate } from "@middle/state-issue";
import type { InFlightItem, RateLimits, SlotUsage } from "@middle/state-issue";
import { Workflow } from "bunqueue/workflow";
import type { StepContext } from "bunqueue/workflow";
import type { SessionGate } from "../hook-server.ts";
import { parseBlockerRef, resolveBlockers } from "../blocker-resolution.ts";
import type { BlockerResolver } from "../blocker-resolution.ts";
import type { EpicGateway } from "../github.ts";
import { applyDispatcherSections } from "../state-issue.ts";
import type { DispatcherSections, StateGateway } from "../state-issue.ts";
import { getRateLimitState } from "../rate-limits.ts";
import type { RateLimitState } from "../rate-limits.ts";
import {
  countActiveImplementationSlots,
  createWorkflowRecord,
  listActiveImplementationWorkflows,
  updateWorkflow,
} from "../workflow-record.ts";
import type { CreateWorktreeOpts, WorktreeHandle } from "../worktree.ts";
import { awaitStopOrSessionEnd } from "./implementation.ts";
import type { TmuxOps, WorktreeOps } from "./implementation.ts";

/** A recommender run: rewrite one repo's state issue with a ranked dispatch plan. */
export type RecommenderInput = {
  /** `owner/name` — the repo whose state issue is rewritten. */
  repo: string;
  /** The state issue number to rewrite, or `0` in file mode (state lives in a file). */
  stateIssue: number;
  /** Adapter to run the recommender agent with. */
  adapter: string;
  /**
   * The repo's Epic-store mode. When `mode === "file"` the prompt frames the run
   * for the file-backed store (rank Epic files under `epicsDir`, rewrite
   * `stateFile`) instead of pointing the agent at the `#<n>` state issue (#200).
   * Absent → github mode.
   */
  epicStore?: EpicStoreSettings;
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
  /**
   * The Epic reference — a numeric Epic/issue number (github mode) or a file-mode
   * Epic slug — or null for a non-issue workflow. Sourced from the workflow's
   * canonical `epicRef` so a file-mode in-flight row carries its slug (#200).
   */
  issue: string | null;
  adapter: string;
  /** "sub-issue m/n" or "running". */
  progress: string;
  /** The tmux session name, or null if not yet launched. */
  session: string | null;
  /**
   * Epoch ms of the last hook heartbeat, or null if none observed. The dispatcher
   * is the only writer of the canonical In-flight line's `last heartbeat <rel>`
   * field; the agent never authors it (#180).
   */
  lastHeartbeat: number | null;
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

/** The per-repo settings the recommender workflow resolves for each run. */
export type RecommenderRunSettings = {
  schemaPath: string;
  config: RecommenderRunConfig;
  repoConfig: RepoConfig;
  agentTimeoutMs?: number;
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
  /**
   * On-disk path to `state-issue.v1.md`. Per-repo via {@link resolveRunSettings}
   * on the daemon; the standalone runner supplies it statically.
   */
  schemaPath?: string;
  /**
   * Reads AND writes the state issue body: `prior_body` for the prompt, the
   * produced body to verify, and the `reapply-dispatcher-sections` overwrite that
   * makes the dispatcher the sole writer of the three owned sections (#180).
   */
  stateIssue: StateGateway;
  /**
   * Resolves `BlockedItem.blocker` references against live state (#225) — the
   * routing `EpicGateway` on the daemon (so a cross-repo blocker resolves against
   * the *blocker's* repo). Used by the `resolve-blockers` step.
   */
  epicGateway: EpicGateway;
  /** Configured adapter names, for `validate()` in the verify step (static-runner path). */
  repoConfig?: RepoConfig;
  /** The `config` block reported to the recommender (static-runner path). */
  config?: RecommenderRunConfig;
  /**
   * Per-repo run settings resolver — the **daemon path**. When set, the workflow
   * resolves `schemaPath`/`config`/`repoConfig`/`agentTimeoutMs` from this for
   * each run's `input.repo`, so ONE workflow registration on the daemon's
   * long-lived engine serves every managed repo (mirrors how the implementation
   * workflow resolves per-repo). When absent, the workflow falls back to the
   * static fields above (the standalone `dispatchRecommender` path). Provide one
   * or the other.
   */
  resolveRunSettings?: (repo: string) => RecommenderRunSettings;
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
   * Cadence for the spawn step's session-liveness probe (the
   * `awaitStopOrSessionEnd` race). Defaults to 5s in production. Exposed so
   * tests can drive it tighter; should be ≪ `agentTimeoutMs` so a session that
   * dies mid-run fails the step in seconds rather than minutes.
   */
  livenessPollMs?: number;
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
  /**
   * Called from `cleanup-worktree` when `verify-state-issue-parses` passed
   * (`verify.ok === true`) — signals that this run was clean, so the
   * recommender-surfacer dedup state can be reset. If the same problem recurs
   * after a clean run it should re-post, not stay silently suppressed.
   *
   * Wired to `recommenderSurfacer.reset` in `main.ts`; left absent in the
   * standalone runner (no long-lived dedup state to reset there).
   */
  onSurfacerReset?: (repo: string) => void;
};

const DEFAULT_LAUNCH_TIMEOUT_MS = 90_000;
// 15-minute hard cap. The spec's original 5 minutes proved too tight against a
// real repo — the agent ran the full window ranking ~4 epics + ~15 issues and
// rewriting the schema-strict state issue without finishing. Operators tune it
// per repo via `[recommender] agent_timeout_minutes`.
const DEFAULT_AGENT_TIMEOUT_MS = 15 * 60 * 1000;
// Hard ceiling on the per-repo agent timeout. The step's bunqueue `timeout` is a
// registration-time backstop and can't see the per-repo `resolveRunSettings`
// value (daemon mode), so it's sized for THIS ceiling; the per-repo `awaitStop`
// is clamped to it. Without the clamp, a repo configured above the default would
// trip the step timeout (a generic error) before its own `awaitStop` (specific)
// fired. Tune-up is allowed up to here, not past it.
const MAX_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

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
  /** File mode reframes the run for the file-backed store (#200); absent → github. */
  epicStore?: EpicStoreSettings;
}): string {
  const { repo, stateIssue, schemaPath, priorBody, context, config, epicStore } = parts;
  const json = (value: unknown): string => JSON.stringify(value, null, 2);
  const fileMode = epicStore?.mode === "file";
  // In file mode the ranked state lives in `state_file`, not a `#<n>` issue, and
  // the dispatch units are Epic files under `epics_dir` — frame the run that way
  // so the agent follows the skill's file-mode commands, not a phantom #0 issue.
  const targetLine = fileMode
    ? `- \`epic_store\`: file (epics_dir: \`${epicStore?.epicsDir ?? "planning/epics"}\`, state_file: \`${epicStore?.stateFile ?? ".middle/state.md"}\`)`
    : `- \`state_issue\`: ${stateIssue}`;
  const priorBodySource = fileMode
    ? `The current contents of the \`state_file\` (\`${epicStore?.stateFile ?? ".middle/state.md"}\`), between the markers below.`
    : `The current contents of state issue #${stateIssue}, between the markers below.`;
  const storeNote = fileMode
    ? "\nThis repo uses the **file-backed** Epic store. Follow the skill's file-mode\ncommands: rank the Epic files under `epics_dir` (not GitHub issues) and rewrite\nthe `state_file` (not a state issue). Epic references in the body are file\nslugs (e.g. `#rollout-epic-store`), not `#<number>`.\n"
    : "";
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

You are the dispatch recommender. Rewrite the state body following the
\`recommending-github-issues\` skill. The dispatcher provides everything below;
read all of it before any \`gh\` calls.
${storeNote}
- \`repo\`: ${repo}
${targetLine}
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
${priorBodySource}

The In-flight, Rate limits, and Slot usage sections are DISPATCHER-OWNED — the
dispatcher overwrites all three with authoritative values (heartbeats included)
immediately after your run, so do not compute them:
- In-flight: emit exactly the empty placeholder \`- _no agents in flight_\`. Do
  NOT reconstruct agent lines from the \`in_flight\` data above — that data is
  ranking input only, and it has no heartbeat, so any line you build from it is
  malformed.
- Rate limits, Slot usage: copy through verbatim from prior_body.

The \`rate_limits\` / \`in_flight\` / \`slots\` blocks above are decision INPUT for
your ranking, never body content.

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
      // The canonical Epic ref (string) — numeric in github mode, a slug in file
      // mode — so a file-mode in-flight row renders its slug, not a dropped null.
      issue: w.epicRef,
      adapter: w.adapter,
      progress: w.state === "running" ? "running" : w.state,
      session: w.sessionName,
      lastHeartbeat: w.lastHeartbeat,
    })),
    slots: {
      perAdapter,
      total: { used: used.total, max: opts.repoMax, globalUsed, globalMax: opts.globalMax },
    },
  };
}

/**
 * Format an epoch-ms heartbeat as the schema's `last heartbeat <rel>` value
 * (`42s ago`, `3m ago`, `2h ago`, `1d ago`); a null heartbeat (none observed) →
 * `unknown`. The parser captures this field loosely (`.+?`), so the format is
 * cosmetic — but it must be non-empty so the canonical line stays parseable.
 */
export function heartbeatRel(ts: number | null, now: number): string {
  if (ts === null) return "unknown";
  const secs = Math.max(0, Math.floor((now - ts) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Convert the dispatcher-owned context into a full {@link DispatcherSections}
 * patch — the canonical content the dispatcher overwrites onto the three
 * dispatcher-owned sections after the agent runs (#180). The dispatcher, not the
 * recommender agent, is the single source of truth for these:
 * - In-flight: each summary becomes a 5-field {@link InFlightItem}, with the
 *   heartbeat the agent never had. Entries with no Epic ref are dropped — the
 *   section's `#<ref>` shape can't represent a non-issue workflow.
 * - Rate limits: passed through (already the dispatcher's shape).
 * - Slot usage: the per-adapter/total/global view flattened to {@link SlotUsage}.
 */
export function dispatcherSectionsFromContext(
  ctx: RecommenderContext,
  now: number,
): Required<DispatcherSections> {
  const inFlight: InFlightItem[] = ctx.inFlight
    .filter((s): s is InFlightSummary & { issue: string } => s.issue !== null)
    .map((s) => ({
      issue: s.issue,
      adapter: s.adapter,
      progress: s.progress,
      lastHeartbeat: heartbeatRel(s.lastHeartbeat, now),
      // tmuxSession must be non-empty for the canonical line; a not-yet-launched
      // agent (null session) reads as "pending".
      tmuxSession: s.session ?? "pending",
    }));
  const slotUsage: SlotUsage = {
    adapters: Object.entries(ctx.slots.perAdapter).map(([adapter, { used, max }]) => ({
      adapter,
      used,
      max,
    })),
    total: { used: ctx.slots.total.used, max: ctx.slots.total.max },
    global: { used: ctx.slots.total.globalUsed, max: ctx.slots.total.globalMax },
  };
  return { inFlight, rateLimits: ctx.rateLimits, slotUsage };
}

type PrepareResult = { handle: WorktreeHandle };
// `settings` is resolved ONCE here and threaded to the later steps (spawn,
// verify, trigger) via ctx — so a live config edit mid-run can't mix different
// schemaPath/config/repoConfig/agentTimeoutMs values within one execution.
type BuildPromptResult = {
  priorBody: string;
  promptText: string;
  settings: RecommenderRunSettings;
};
type VerifyResult = { ok: boolean; errors: string[] };

/**
 * The `recommender` workflow (build spec → "bunqueue workflows" →
 * "recommender workflow"):
 *
 *   check-rate-limit → prepare-shallow-worktree → build-prompt
 *     → spawn-recommender-agent (5-min hard cap) → reapply-dispatcher-sections
 *     → resolve-blockers → verify-state-issue-parses → trigger-auto-dispatch
 *     → cleanup-worktree
 *
 * Linear (no park/resume — the recommender is a short one-shot). The recommender
 * records its `workflows` row with `kind:"recommender"`, so it runs on its own
 * dedicated slot and is never counted against `maxConcurrent`. Built as a factory
 * so the dispatcher injects real collaborators and tests inject stubs.
 */
export function createRecommenderWorkflow(deps: RecommenderDeps): Workflow<RecommenderInput> {
  const launchTimeout = deps.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;

  /**
   * Resolve the run's per-repo settings: the daemon's `resolveRunSettings(repo)`
   * when wired (one registration serves every repo), else the static deps (the
   * standalone runner). One path must be present — a missing both is a wiring bug.
   */
  function runSettings(repo: string): RecommenderRunSettings {
    if (deps.resolveRunSettings) return deps.resolveRunSettings(repo);
    if (
      deps.schemaPath === undefined ||
      deps.config === undefined ||
      deps.repoConfig === undefined
    ) {
      throw new Error(
        "recommender deps: provide resolveRunSettings (daemon) or schemaPath+config+repoConfig (standalone)",
      );
    }
    return {
      schemaPath: deps.schemaPath,
      config: deps.config,
      repoConfig: deps.repoConfig,
      agentTimeoutMs: deps.agentTimeoutMs,
    };
  }

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
      epicRef: null,
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
    const settings = runSettings(ctx.input.repo);
    const promptText = assembleRecommenderPrompt({
      repo: ctx.input.repo,
      stateIssue: ctx.input.stateIssue,
      schemaPath: settings.schemaPath,
      priorBody,
      context,
      config: settings.config,
      epicStore: ctx.input.epicStore,
    });
    // The launch references `.middle/prompt.md`; write the assembled context there.
    const middleDir = join(handle.path, ".middle");
    mkdirSync(middleDir, { recursive: true });
    writeFileSync(join(middleDir, "prompt.md"), promptText);
    return { priorBody, promptText, settings };
  }

  async function spawnRecommenderAgent(ctx: StepContext<RecommenderInput>): Promise<void> {
    const { handle } = ctx.steps["prepare-shallow-worktree"] as PrepareResult;
    const { settings } = ctx.steps["build-prompt"] as BuildPromptResult;
    const adapter = deps.getAdapter(ctx.input.adapter);
    // Clamp the per-repo timeout to the ceiling the step backstop is sized for,
    // so the internal (specific-error) Stop-await always fires before the step's.
    const agentTimeout = Math.min(
      settings.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
      MAX_AGENT_TIMEOUT_MS,
    );
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
        epicRef: String(ctx.input.stateIssue),
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

      // The recommender is a one-shot: drive one turn, observe the Stop.
      // Liveness-aware (mirrors the implementation drive): race the Stop hook
      // against tmux session-death so a session killed out from under us (a
      // watchdog kill, a daemon force-close mid-run, a tmux crash) fails the
      // step *immediately* with a specific reason instead of blocking on
      // `awaitStop` for the full `agentTimeout` (a 15-min stall the bunqueue
      // force-close would otherwise terminate as a generic compensation). When
      // `tmux.status` is unwired (tests / standalone runner), it degrades to
      // Stop-or-timeout — same behavior as before.
      const wait = await awaitStopOrSessionEnd({
        awaitStop: (ms) => deps.sessionGate.awaitStop(sessionName, ms),
        timeoutMs: agentTimeout,
        isAlive: deps.tmux.status
          ? async () => (await deps.tmux.status!(sessionName)).alive
          : undefined,
        pollMs: deps.livenessPollMs,
      });
      if (wait.via === "session-ended") {
        throw new Error("recommender session ended before Stop hook");
      }
      if (wait.via === "timeout") {
        throw new Error(`recommender Stop hook timed out after ${agentTimeout}ms`);
      }
      // END SESSION — the turn is over; free the dedicated slot.
      await deps.tmux.killSession(sessionName);
    } catch (error) {
      console.error(`${tag} spawn failed: ${(error as Error).message}`);
      await deps.tmux.killSession(sessionName);
      throw error;
    }
  }

  /**
   * Overwrite the three dispatcher-owned sections (In-flight / Rate limits / Slot
   * usage) with canonical content built from the dispatcher's own state — making
   * the dispatcher the single writer of those sections (#180). The recommender
   * agent is told to emit the canonical empty placeholder for them; this step
   * replaces that placeholder with the authoritative values (heartbeat included).
   *
   * Best-effort by design: if the agent disobeyed and produced a body that
   * doesn't even parse, a surgical section overwrite is impossible, so this skips
   * and lets `verify-state-issue-parses` be the single surfacing point (no double
   * comment). Re-gathers context here (not from build-prompt) so the In-flight
   * snapshot reflects state *after* the agent's run.
   */
  async function reapplyDispatcherSections(ctx: StepContext<RecommenderInput>): Promise<void> {
    const before = await deps.stateIssue.readBody(ctx.input.repo, ctx.input.stateIssue);
    const parsed = parseStateIssue(before);
    if (isParseError(parsed)) {
      console.error(
        `[recommender] reapply skipped — agent body for #${ctx.input.stateIssue} does not parse: ${parsed.message}`,
      );
      return;
    }
    const sections = dispatcherSectionsFromContext(deps.gatherContext(ctx.input.repo), Date.now());
    const after = renderStateIssue(applyDispatcherSections(parsed, sections));
    if (after === before) return; // already canonical — skip a no-op write
    await deps.stateIssue.writeBody(ctx.input.repo, ctx.input.stateIssue, after);
  }

  /**
   * Resolve cross-repo (and same-repo) `BlockedItem.blocker` references against
   * live state and reclassify the blocked items (#225): a closed blocker unblocks
   * the item into `Ready to dispatch`, an open one annotates the line with the
   * blocker's title, an unresolvable one gets a `(stale blocker: …)` suffix. This
   * is the runtime consumer of `BlockedItem.blocker` the audit found missing.
   *
   * Best-effort and idempotent, mirroring `reapply-dispatcher-sections`: if the
   * agent body doesn't parse, skip (verify surfaces it); if there are no
   * resolvable blockers, skip the read of `listOpenEpics` and any write. Runs
   * AFTER the dispatcher-owned reapply so it reads the latest body, and BEFORE
   * verify so the reclassified body is what gets validated.
   */
  async function resolveBlockersStep(ctx: StepContext<RecommenderInput>): Promise<void> {
    const before = await deps.stateIssue.readBody(ctx.input.repo, ctx.input.stateIssue);
    const parsed = parseStateIssue(before);
    if (isParseError(parsed)) return; // verify-state-issue-parses surfaces it
    // Skip the gateway round-trips entirely when no blocked item carries a
    // resolvable issue reference (a backticked / free-text blocker never resolves).
    const hasResolvable = parsed.blocked.some(
      (b) => parseBlockerRef(b.blocker).kind !== "non-issue",
    );
    if (!hasResolvable) return;

    const { settings } = ctx.steps["build-prompt"] as BuildPromptResult;
    // Prefetch this repo's open Epics for accurate Ready rows on an unblock (title
    // + open sub-issue count). Best-effort — a gh failure falls back to per-issue
    // resolution with a sub-issue count of 1.
    let selfEpic: BlockerResolver["selfEpic"];
    try {
      const epics = await deps.epicGateway.listOpenEpics(ctx.input.repo);
      const byNumber = new Map<number, { title: string; openSubIssues: number }>();
      for (const e of epics) {
        if (e.number !== null) {
          byNumber.set(e.number, {
            title: e.title,
            openSubIssues: Math.max(0, e.subTotal - e.subClosed),
          });
        }
      }
      selfEpic = (issue) => byNumber.get(issue);
    } catch (error) {
      console.error(
        `[recommender] resolve-blockers: listOpenEpics for ${ctx.input.repo} failed: ${(error as Error).message}`,
      );
    }

    const resolver: BlockerResolver = {
      repo: ctx.input.repo,
      defaultAdapter: settings.config.defaultAdapter,
      resolveIssue: (repo, issue) => deps.epicGateway.getIssueState(repo, String(issue)),
      selfEpic,
    };
    const next = await resolveBlockers(parsed, resolver);
    const after = renderStateIssue(next);
    if (after === before) return; // nothing reclassified — skip a no-op write
    await deps.stateIssue.writeBody(ctx.input.repo, ctx.input.stateIssue, after);
  }

  async function verifyStateIssueParses(ctx: StepContext<RecommenderInput>): Promise<VerifyResult> {
    const body = await deps.stateIssue.readBody(ctx.input.repo, ctx.input.stateIssue);
    const parsed = parseStateIssue(body);
    if (isParseError(parsed)) {
      const problem = `state issue #${ctx.input.stateIssue} does not parse: ${parsed.message}`;
      await surface(ctx, problem);
      return { ok: false, errors: [parsed.message] };
    }
    const { settings } = ctx.steps["build-prompt"] as BuildPromptResult;
    const result = validate(parsed, settings.repoConfig);
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
    // File mode (sentinel stateIssue 0) has no GitHub issue to comment on — the
    // problem is already on stderr; a `gh` comment on #0 would only error (#200).
    if (ctx.input.stateIssue === 0) return;
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
    const { settings } = ctx.steps["build-prompt"] as BuildPromptResult;
    // Gate on a clean parse + the frozen per-run auto_dispatch setting.
    if (!verify.ok || !settings.config.autoDispatch || !deps.triggerAutoDispatch) return;
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
    // A clean run resets the surfacer dedup state so a problem that recurs
    // after being fixed re-posts rather than staying silently suppressed.
    if (verify?.ok === true) {
      deps.onSurfacerReset?.(ctx.input.repo);
    }
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
        // Registration-time backstop above the internal Stop-await (which is the
        // controlling, per-repo timeout). Uses the static `agentTimeoutMs` when
        // given, else the default — a generous outer cap, not the precise bound.
        // Sized for the per-repo ceiling (MAX_AGENT_TIMEOUT_MS), since this
        // registration-time value can't see `resolveRunSettings`; the per-repo
        // `awaitStop` is clamped to that ceiling, so this always exceeds it.
        timeout: launchTimeout + MAX_AGENT_TIMEOUT_MS + 30_000,
      })
      .step("reapply-dispatcher-sections", reapplyDispatcherSections)
      .step("resolve-blockers", resolveBlockersStep)
      .step("verify-state-issue-parses", verifyStateIssueParses)
      .step("trigger-auto-dispatch", triggerAutoDispatch)
      .step("cleanup-worktree", cleanupWorktree)
  );
}
