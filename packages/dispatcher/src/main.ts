// @middle/dispatcher — the long-running dispatcher process.
//
// The daemon owns the one long-lived bunqueue engine that hosts every dispatch
// AND every review-resume continuation (the poller's resume signal targets this
// engine). It stands up the SQLite db, the hook receiver + control plane, the
// EventHub broadcast feed, and the watchdog/poller crons, then idles until
// signalled. `mm start` spawns this; `mm stop` (and `mm dispatch` clients)
// drive it over the HTTP control plane. `mm stop` sends it SIGTERM.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeAdapter } from "@middle/adapter-claude";
import type { AgentAdapter } from "@middle/core";
import { loadConfig } from "@middle/core";
import { Engine } from "bunqueue/workflow";
import { autoDispatch } from "./auto-dispatch.ts";
import { buildImplementationDeps } from "./build-deps.ts";
import { installBunqueueRaceSwallower } from "./bunqueue-race.ts";
import { openAndMigrate } from "./db.ts";
import { EventHub } from "./event-hub.ts";
import { type ControlPlane, HookServer } from "./hook-server.ts";
import { collectMetrics } from "./metrics.ts";
import type { RecommenderTrigger } from "./hook-server.ts";
import { DbHookStore } from "./hook-store.ts";
import { getRateLimitState, setRateLimitObserver } from "./rate-limits.ts";
import { dispatchRecommender, resolveRecommenderOptions } from "./recommender-run.ts";
import { ghPollGateway } from "./poller-gateway.ts";
import { startPoller } from "./poller-cron.ts";
import { isPaused } from "./repo-config.ts";
import { getSlotState, hasFreeSlot } from "./slots.ts";
import { ghStateIssueGateway, readState } from "./state-issue.ts";
import { killSession, status } from "./tmux.ts";
import { startWatchdog } from "./watchdog-cron.ts";
import { pruneWorktreeAt } from "./worktree.ts";
import {
  getWorkflow,
  hasNonTerminalEpicWorkflow,
  listNonTerminalWorkflows,
  setUpdateWorkflowObserver,
} from "./workflow-record.ts";
import type { ControlDispatchInput } from "./hook-server.ts";
import { createImplementationWorkflow, RESUME_EVENT } from "./workflows/implementation.ts";

/**
 * The dashboard-agnostic context the daemon hands to {@link RunDaemonOptions.hostExtras}.
 * Names no dashboard type — the CLI composition root maps these primitives onto
 * the dashboard's seams.
 */
export type DaemonHostContext = {
  db: ReturnType<typeof openAndMigrate>;
  config: ReturnType<typeof loadConfig>;
  stateGateway: typeof ghStateIssueGateway;
  runRecommender: (repo: string) => Promise<{ status: number; body: string }>;
};

/** Options for {@link runDaemon}. `hostExtras` injects the dashboard (or any extra routes). */
export type RunDaemonOptions = {
  /**
   * Mount extra HTTP routes on the daemon's single server and register a disposer
   * run on shutdown. Called once after the db/state are up, before the server binds.
   */
  hostExtras?: (ctx: DaemonHostContext) => {
    routes: Record<string, unknown>;
    dispose: () => void;
  };
};

/** Workflow states that free a dispatch slot — a transition into one re-runs auto-dispatch. */
const SLOT_FREEING_STATES = new Set(["completed", "compensated", "failed", "cancelled"]);
/** Debounce window coalescing a burst of triggers (terminal transitions, etc.) into one pass. */
const AUTO_DISPATCH_DEBOUNCE_MS = 250;

/** Adapter registry — only `claude` is implemented. */
function getAdapter(name: string): AgentAdapter {
  if (name !== "claude") throw new Error(`unknown adapter: ${name}`);
  return claudeAdapter;
}

/** The dispatcher's own version, reported by `GET /health`. */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
}

export async function runDaemon(opts: RunDaemonOptions = {}): Promise<void> {
  const config = loadConfig({ globalPath: process.env.MIDDLE_CONFIG });

  mkdirSync(dirname(config.global.dbPath), { recursive: true });
  const db = openAndMigrate(config.global.dbPath);

  // Disposer for any host-injected extras (the dashboard) — run on shutdown.
  let hostDispose: (() => void) | null = null;

  // Swallow only bunqueue's benign lock-token lifecycle race for the daemon's
  // lifetime; removed on shutdown. The engine drains here on SIGTERM, which is
  // exactly when that race can surface.
  const uninstallRaceSwallower = installBunqueueRaceSwallower();

  // The control plane's broadcast feed. The daemon is the sole producer; clients
  // (`mm dispatch`, later the dashboard) consume it via `/control/events`.
  const hub = new EventHub();

  // The one long-lived engine. Parked executions live here so the poller can
  // resume them; it is in-memory (durable persistence across restart is deferred,
  // #116) — do NOT add a no-op engine.recover() against the in-memory store.
  const engine = new Engine({ embedded: true });

  // Declared up front: `scheduleAutoDispatch` (hoisted below) reads it, and a
  // slot-freeing broadcast can fire that path the moment the engine observers
  // are wired — long before `shutdown` is defined. A `let` initialized later
  // would throw a TDZ ReferenceError on that early read.
  let shuttingDown = false;

  // One place that turns a state change into a `workflow` broadcast (repo/epic
  // looked up from the row). Fed by two sources below. They overlap on the
  // states the workflow writes to the row AND bunqueue emits (`completed`,
  // around compensation), so collapse a consecutive identical (id, state) frame
  // — otherwise a normal completion double-broadcasts. NB: the entry is NOT
  // pruned on a terminal state — the duplicate terminal frame from the other
  // source arrives right after, and pruning would let it through. The map grows
  // one tiny entry per execution over the daemon's (in-memory, restartable) life.
  // 409 collision reservation. `inFlightEpics` holds epics whose dispatch has
  // been accepted but whose workflow row may not exist yet (the row is written
  // asynchronously inside engine.start's first step). The synchronous
  // check-and-reserve in `startDispatch` closes the TOCTOU; the reservation is
  // released once the row exists — the first broadcast that resolves it, below —
  // after which `hasNonTerminalEpicWorkflow` (the DB) is the source of truth.
  const inFlightEpics = new Set<string>();
  const epicKey = (repo: string, epicNumber: number): string => `${repo}#${epicNumber}`;

  const lastBroadcastState = new Map<string, string>();
  const broadcastWorkflow = (executionId: string, state: string): void => {
    if (lastBroadcastState.get(executionId) === state) return;
    lastBroadcastState.set(executionId, state);
    const row = getWorkflow(db, executionId);
    // The workflow row now exists → drop any pre-row dispatch reservation; the
    // DB collision check covers this epic from here on.
    if (row && row.epicNumber !== null) inFlightEpics.delete(epicKey(row.repo, row.epicNumber));
    hub.broadcast({
      type: "workflow",
      data: { id: executionId, repo: row?.repo ?? "", epic: row?.epicNumber ?? null, state },
    });
    // Trigger #2: a workflow terminal-state transition freed a slot — re-run
    // auto-dispatch for that repo so the next ready Epic takes the slot.
    if (row && SLOT_FREEING_STATES.has(state)) scheduleAutoDispatch(row.repo);
  };

  // Source 1: bunqueue-native lifecycle (running/waiting/completed/failed/compensating).
  engine.onAny((event) => {
    if (event.type.startsWith("workflow:") && "state" in event) {
      broadcastWorkflow(event.executionId, (event as { state: string }).state);
    }
  });
  // Source 2: middle's DB-only states bunqueue never emits (waiting-human, the
  // handoff `completed`). The observer fires after each updateWorkflow write.
  setUpdateWorkflowObserver((id, patch) => {
    if (patch.state) broadcastWorkflow(id, patch.state);
  });

  const version = readVersion();

  // Per-repo checkout registry: `/control/dispatch` carries `repoPath` (the daemon
  // has no inherent knowledge of where a repo lives); the workflow's
  // resolveRepoPath reads it. In-memory — see the durability note on the engine.
  const repoPaths = new Map<string, string>();

  // ── Auto-dispatch (build spec → "Auto-dispatch loop") ──────────────────────
  // The collision-guarded enqueue: the single source of truth for the 409 guard
  // (the active-check and reservation run with no intervening await). Both the
  // control route AND the auto-dispatch loop enqueue through this — the loop calls
  // it directly (not the HTTP route), so its enqueues never re-trigger the loop.
  // `source` is recorded on the workflow: `"manual"` for a route dispatch
  // (`mm dispatch`), `"auto"` for an auto-dispatch-loop enqueue.
  async function startDispatchImpl(
    input: ControlDispatchInput,
    source: "manual" | "auto",
  ): Promise<string | null> {
    const key = epicKey(input.repo, input.epicNumber);
    if (inFlightEpics.has(key) || hasNonTerminalEpicWorkflow(db, input.repo, input.epicNumber)) {
      return null;
    }
    inFlightEpics.add(key);
    try {
      repoPaths.set(input.repo, input.repoPath);
      const handle = await engine.start("implementation", {
        repo: input.repo,
        epicNumber: input.epicNumber,
        adapter: input.adapter,
        source,
      });
      return handle.id;
    } catch (error) {
      // Start failed → no row will exist to release the reservation via the
      // broadcast path, so free the slot here rather than leak it.
      inFlightEpics.delete(key);
      throw error;
    }
  }

  /** Resolve a repo's merged slot caps for {@link getSlotState}. */
  function resolveSlotLimits(repoConfig: ReturnType<typeof loadConfig>) {
    return {
      perAdapter: repoConfig.limits?.maxConcurrentPerAdapter ?? {},
      repoMax: repoConfig.limits?.maxConcurrent ?? repoConfig.global.maxConcurrent,
      globalMax: repoConfig.global.maxConcurrent,
    };
  }

  /** Load a repo's merged config from a checkout path, or null if it can't be read. */
  function loadConfigAt(repoPath: string): ReturnType<typeof loadConfig> | null {
    try {
      return loadConfig({
        globalPath: process.env.MIDDLE_CONFIG,
        repoPath: join(repoPath, ".middle", "config.toml"),
      });
    } catch {
      return null;
    }
  }

  /** Load a repo's merged config from its registered checkout, or null if unavailable. */
  function loadRepoConfig(repo: string): ReturnType<typeof loadConfig> | null {
    const repoPath = repoPaths.get(repo);
    return repoPath === undefined ? null : loadConfigAt(repoPath);
  }

  /**
   * Whether a manual dispatch has a free slot right now (manual `mm dispatch`
   * respects slot limits — build spec → "Auto-dispatch loop"). Resolves caps from
   * the request's own `repoPath`, so the gate holds even on a repo the daemon
   * hasn't dispatched yet this lifetime (cold `repoPaths`). Conservative: an
   * unreadable config reports a free slot rather than blocking a manual dispatch.
   */
  function slotAvailable(input: ControlDispatchInput): boolean {
    const repoConfig = loadConfigAt(input.repoPath);
    if (!repoConfig) return true;
    return hasFreeSlot(getSlotState(db, input.repo, resolveSlotLimits(repoConfig)), input.adapter);
  }

  /** The adapter names currently RATE_LIMITED with a reset still in the future. */
  function rateLimitedAdapters(adapters: string[]): Set<string> {
    const now = Date.now();
    const limited = new Set<string>();
    for (const adapter of adapters) {
      const state = getRateLimitState(db, adapter);
      if (state?.status === "RATE_LIMITED" && (state.resetAt === null || state.resetAt > now)) {
        limited.add(adapter);
      }
    }
    return limited;
  }

  /** Run one auto-dispatch pass for a repo, building deps from its merged config. */
  async function runAutoDispatch(repo: string): Promise<void> {
    const repoPath = repoPaths.get(repo);
    if (repoPath === undefined) return; // unknown checkout — can't locate the repo
    const repoConfig = loadRepoConfig(repo);
    if (!repoConfig) return;
    const stateIssueNumber = repoConfig.stateIssue?.number;
    if (stateIssueNumber === undefined || stateIssueNumber === 0) return;
    const limits = resolveSlotLimits(repoConfig);
    const adapters = Object.keys(repoConfig.adapters);
    const result = await autoDispatch({
      repo,
      // Enabled = the per-repo toggle is on AND the repo isn't paused (#51).
      isAutoDispatchEnabled: () =>
        (repoConfig.recommender?.autoDispatch ?? false) && !isPaused(db, repo),
      readState: () => readState(ghStateIssueGateway, repo, stateIssueNumber),
      rateLimitedAdapters: () => rateLimitedAdapters(adapters),
      getSlotState: () => getSlotState(db, repo, limits),
      enqueue: ({ repo: r, epicNumber, adapter }) =>
        startDispatchImpl({ repo: r, repoPath, epicNumber, adapter }, "auto"),
    });
    if (result.enqueued.length > 0) {
      const list = result.enqueued.map((e) => `#${e.epicNumber}(${e.adapter})`).join(", ");
      console.log(`[auto-dispatch] ${repo}: enqueued ${list} — ${result.reason}`);
    }
  }

  // Debounced, re-entrancy-guarded scheduler so a burst of triggers (many
  // terminal transitions, a rate-limit flip) coalesces into one pass per repo,
  // and a trigger arriving mid-pass re-runs once after it finishes.
  const autoDispatchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const autoDispatchRunning = new Set<string>();
  const autoDispatchRerun = new Set<string>();
  function scheduleAutoDispatch(repo: string): void {
    if (shuttingDown) return;
    const existing = autoDispatchTimers.get(repo);
    if (existing) clearTimeout(existing);
    autoDispatchTimers.set(
      repo,
      setTimeout(() => {
        autoDispatchTimers.delete(repo);
        if (autoDispatchRunning.has(repo)) {
          autoDispatchRerun.add(repo);
          return;
        }
        autoDispatchRunning.add(repo);
        void runAutoDispatch(repo)
          .catch((error: unknown) => {
            console.error(`[auto-dispatch] ${repo} failed: ${(error as Error).message}`);
          })
          .finally(() => {
            autoDispatchRunning.delete(repo);
            if (autoDispatchRerun.delete(repo)) scheduleAutoDispatch(repo);
          });
      }, AUTO_DISPATCH_DEBOUNCE_MS),
    );
  }

  // Trigger #3: any rate-limit state change re-runs auto-dispatch for every known
  // repo (rate-limit state is cross-repo, keyed by adapter — a reset can unblock
  // ready work anywhere).
  setRateLimitObserver(() => {
    for (const repo of repoPaths.keys()) scheduleAutoDispatch(repo);
  });

  // Dashboard "run recommender now" trigger (build spec → Phase 7). The run
  // rewrites the state issue on its own ephemeral engine; Trigger #1 (recommender
  // run completes) then schedules an auto-dispatch pass on THIS daemon's engine.
  // The repo's checkout is registered up front so that pass can locate it. The
  // run uses an ephemeral port so it never collides with the live dispatcher's.
  const recommenderTrigger: RecommenderTrigger = async ({ repoPath }) => {
    if (!repoPath) return { status: 400, body: "repoPath required" };
    let repoConfig: ReturnType<typeof loadConfig>;
    try {
      repoConfig = loadConfig({
        globalPath: process.env.MIDDLE_CONFIG,
        repoPath: join(repoPath, ".middle", "config.toml"),
      });
    } catch (error) {
      return { status: 500, body: `config load failed: ${(error as Error).message}` };
    }
    const resolved = await resolveRecommenderOptions(repoPath, repoConfig, getAdapter);
    if (!resolved.ok) return { status: 400, body: resolved.error };
    const repoSlug = resolved.options.repoSlug;
    repoPaths.set(repoSlug, repoPath);
    void dispatchRecommender({
      ...resolved.options,
      dispatcherPort: 0,
      // Trigger #1: when the run completes (clean parse + auto_dispatch on), the
      // recommender workflow fires this back into the daemon to run the loop.
      triggerAutoDispatch: async ({ repo }) => scheduleAutoDispatch(repo),
    }).catch((error: unknown) => {
      console.error(`[main] recommender trigger run failed: ${(error as Error).message}`);
    });
    return { status: 202, body: "recommender run started" };
  };

  // Wire the workflow deps + PR-ready gate via the shared factory. `bindServer`
  // builds the hook receiver WITH the gate (a latent gap the standalone path had
  // wired but the daemon never did) AND the control plane (engine/hub/version +
  // the collision/adapter queries), then hands back the live session gate + URL.
  let hookServer!: HookServer;
  const { deps } = await buildImplementationDeps({
    db,
    getAdapter,
    resolveRepoPath: (repo) => {
      const path = repoPaths.get(repo);
      if (path === undefined) throw new Error(`no checkout path registered for repo ${repo}`);
      return path;
    },
    worktreeRoot: config.global.worktreeRoot,
    // The dispatch brief tells the agent its fork budget — the repo's
    // `[limits] complexity_ceiling` (default 3), resolved per repo.
    resolveComplexityCeiling: (repo) => {
      const repoPath = repoPaths.get(repo);
      if (repoPath === undefined) return 3;
      try {
        return (
          loadConfig({
            globalPath: process.env.MIDDLE_CONFIG,
            repoPath: join(repoPath, ".middle", "config.toml"),
          }).limits?.complexityCeiling ?? 3
        );
      } catch {
        return 3;
      }
    },
    // Resume hand-off: a continuation round re-enters the workflow on THIS engine,
    // so a parked execution and its resume both live where the poller signals.
    enqueueContinuation: async (input) => {
      await engine.start("implementation", input);
    },
    bindServer: (prReadyGate) => {
      const control: ControlPlane = {
        hub,
        version,
        knownAdapter: (name) => name === "claude",
        // A route dispatch is a manual `mm dispatch` — recorded `source: 'manual'`.
        startDispatch: (input) => startDispatchImpl(input, "manual"),
        // Manual dispatch respects slot limits (the loop does its own accounting).
        slotAvailable,
        // Trigger #4: a manual `mm dispatch` (a route dispatch) re-runs the loop
        // so any slot this dispatch didn't claim gets filled. The loop's own
        // enqueues bypass the route, so this never re-enters the loop.
        afterDispatch: scheduleAutoDispatch,
        initEvents: () =>
          listNonTerminalWorkflows(db).map((w) => ({
            type: "workflow",
            data: { id: w.id, repo: w.repo, epic: w.epicNumber, state: w.state },
          })),
        // Observability surfaces read the shared db directly (stateless snapshot).
        metrics: () => collectMetrics(db),
      };
      hookServer = new HookServer(new DbHookStore(db), prReadyGate, recommenderTrigger, control);
      let extraRoutes: Record<string, unknown> = {};
      if (opts.hostExtras) {
        const hosted = opts.hostExtras({
          db,
          config,
          stateGateway: ghStateIssueGateway,
          runRecommender: async (repo: string) => {
            const path = repoPaths.get(repo);
            if (path === undefined) return { status: 404, body: `no checkout for ${repo}` };
            return recommenderTrigger({ repoPath: path });
          },
        });
        extraRoutes = hosted.routes;
        hostDispose = hosted.dispose;
      }
      hookServer.start(config.global.dispatcherPort, extraRoutes);
      return { sessionGate: hookServer, dispatcherUrl: `http://127.0.0.1:${hookServer.port}` };
    },
  });

  // Register before announcing readiness: a `/control/dispatch` request is only
  // serviced on a later event-loop tick, by which point the workflow is registered.
  engine.register(createImplementationWorkflow(deps));

  // Watchdog cron: every 30s, correct transcript drift then reconcile every
  // launching/running workflow (launch-timeout, tmux liveness, idle detection,
  // sentinel re-arm). The reconcile logic is adapter-agnostic via getAdapter.
  const stopWatchdog = await startWatchdog({
    db,
    tmux: { status, killSession },
    getAdapter,
  });

  // GitHub poller: every 60s, for each parked workflow with an armed wait, fire
  // its resume signal when the unblocking event appears (a human reply, or a PR
  // review verdict). `fireSignal` delivers it to this engine — the one that now
  // hosts the parked executions, so review-resume actually fires.
  const stopPoller = await startPoller({
    db,
    github: ghPollGateway,
    fireSignal: (workflowId, payload) => engine.signal(workflowId, RESUME_EVENT, payload),
    // Reconcile pass: when a parked Epic's PR has merged/closed, finalize the row
    // and best-effort tear down its worktree (repo checkout from the registry).
    removeWorktree: (repo, worktreePath) =>
      worktreePath ? pruneWorktreeAt(repoPaths.get(repo) ?? null, worktreePath) : Promise.resolve(),
  });

  console.log(`middle dispatcher up — hooks on :${hookServer.port}, db ${config.global.dbPath}`);

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Guard each teardown so a throw/rejection can't skip process.exit.
    setUpdateWorkflowObserver(null);
    setRateLimitObserver(null);
    try {
      hostDispose?.();
    } catch (error) {
      console.error(`shutdown: host dispose failed — ${(error as Error).message}`);
    }
    for (const timer of autoDispatchTimers.values()) clearTimeout(timer);
    autoDispatchTimers.clear();
    try {
      await stopWatchdog();
    } catch (error) {
      console.error(`shutdown: stopWatchdog failed — ${(error as Error).message}`);
    }
    try {
      await stopPoller();
    } catch (error) {
      console.error(`shutdown: stopPoller failed — ${(error as Error).message}`);
    }
    try {
      hookServer.stop();
    } catch (error) {
      console.error(`shutdown: hookServer.stop failed — ${(error as Error).message}`);
    }
    try {
      await engine.close(true);
    } catch (error) {
      console.error(`shutdown: engine.close failed — ${(error as Error).message}`);
    }
    try {
      db.close();
    } catch (error) {
      console.error(`shutdown: db.close failed — ${(error as Error).message}`);
    }
    uninstallRaceSwallower();
    console.log("middle dispatcher stopped");
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // idle — the hook server keeps the event loop alive
  await new Promise<void>(() => {});
}

// Standalone run (`bun main.ts`) starts the daemon WITHOUT the dashboard. The CLI
// (`mm start`) spawns daemon-entry.ts instead, which calls runDaemon with hostExtras.
if (import.meta.main) {
  runDaemon().catch((error: unknown) => {
    console.error(`middle dispatcher failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
