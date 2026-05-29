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
import type { MiddleConfig } from "@middle/core";
import { loadConfig } from "@middle/core";
import { STATE_ISSUE_SCHEMA_PATH } from "@middle/state-issue";
import type { Database } from "bun:sqlite";
import { getAdapter, isKnownAdapter } from "./adapters.ts";
import { autoDispatch } from "./auto-dispatch.ts";
import { buildImplementationDeps } from "./build-deps.ts";
import { installBunqueueRaceSwallower } from "./bunqueue-race.ts";
import { openAndMigrate } from "./db.ts";
import { refreshEpics } from "./epics-cache.ts";
import { EventHub } from "./event-hub.ts";
import { ghGitHub } from "./github.ts";
import { type ControlPlane, HookServer } from "./hook-server.ts";
import { collectMetrics } from "./metrics.ts";
import type { RecommenderTrigger } from "./hook-server.ts";
import { DbHookStore } from "./hook-store.ts";
import { addRateLimitObserver, clearRateLimitObservers, getRateLimitState } from "./rate-limits.ts";
import { ghSurfaceProblem, resolveRecommenderOptions } from "./recommender-run.ts";
import { ghPollGateway } from "./poller-gateway.ts";
import { startPoller } from "./poller-cron.ts";
import { ghReconcilerGateway, gitOps, reconcileOpenPRs } from "./reconcilers/pr-divergence.ts";
import { createDurableEngine, recoverEngine, reconcileOrphanedSignals } from "./recovery.ts";
import { runRecommenderCronPass, startRecommenderCron } from "./recommender-cron.ts";
import { startAuditCron } from "./audit-cron.ts";
import { startStalenessCron } from "./staleness-cron.ts";
import { isPaused, listManagedRepos, registerManagedRepo } from "./repo-config.ts";
import { getSlotState, hasFreeSlot } from "./slots.ts";
import { ghStateIssueGateway, readState, type StateIssueGateway } from "./state-issue.ts";
import { capturePane, killSession, newSession, sendEnter, sendText, status } from "./tmux.ts";
import { startWatchdog } from "./watchdog-cron.ts";
import { createWorktree, destroyWorktree, pruneWorktreeAt } from "./worktree.ts";
import { buildRecommenderContext, createRecommenderWorkflow } from "./workflows/recommender.ts";
import {
  addWorkflowObserver,
  clearWorkflowObservers,
  getWorkflow,
  hasNonTerminalEpicWorkflow,
  listNonTerminalWorkflows,
  promotePendingToFailed,
} from "./workflow-record.ts";
import type { ControlDispatchInput } from "./hook-server.ts";
import { createImplementationWorkflow, RESUME_EVENT } from "./workflows/implementation.ts";

/**
 * The dashboard-agnostic context the daemon hands to {@link RunDaemonOptions.hostExtras}.
 * Names no dashboard type — the CLI composition root maps these primitives onto
 * the dashboard's seams.
 */
export type DaemonHostContext = {
  db: Database;
  config: MiddleConfig;
  stateGateway: StateIssueGateway;
  runRecommender: (repo: string) => Promise<{ status: number; body: string }>;
  /** Force-dispatch an Epic with a chosen adapter — same path as `mm dispatch`. */
  dispatch: (
    repo: string,
    epicNumber: number,
    adapter: string,
  ) => Promise<{ status: number; body: string }>;
  /** Refresh a repo's Epic browse cache from GitHub. */
  refreshEpics: (repo: string) => Promise<{ status: number; body: string }>;
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
/** Epic-cache refresh cadence (constant, like POLLER/WATCHDOG; config-ification deferred). */
const EPICS_REFRESH_INTERVAL_MS = 60_000;

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

  // The single source of truth for "is this adapter dispatchable right now,
  // and if not, why?" Used by `dispatchEpicManual` (the dashboard's direct
  // hostExtras path) and the hook server's `/control/dispatch` route via
  // `ControlPlane.adapterRejection`, so both surfaces gate AND format the
  // diagnostic identically — the user trying to dispatch on a disabled adapter
  // sees the real reason, never a misleading "unknown" message. `isKnownAdapter`
  // alone gates only on "implemented"; the CLI does its own gating, but a
  // direct route POST or a dashboard call lands here without the CLI's check.
  const adapterRejectionReason = (name: string): string | null => {
    if (!isKnownAdapter(name)) return `unknown adapter: ${name}`;
    if (!(config.adapters[name]?.enabled ?? false)) {
      return `adapter ${name} is disabled in config`;
    }
    return null;
  };

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
  // resume them. `createDurableEngine` gives it a persistent execution store
  // (a SQLite db alongside `db.sqlite3` under the middle data dir) so a parked
  // `waiting` execution survives a daemon restart and is re-armed by
  // `recoverEngine` on boot (#116) — while keeping the step queue in-memory (see
  // that factory + this package's CLAUDE.md for why the queue must NOT persist).
  // Its parent dir is the `mkdirSync` above.
  const queuePath = join(dirname(config.global.dbPath), "queue.sqlite3");
  const engine = createDurableEngine(queuePath);

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
      const state = (event as { state: string }).state;
      // A terminal bunqueue failure of the first step (prepare-worktree) leaves
      // the middle row stranded at `pending` — the saga has no completed step to
      // compensate, so nothing marks it terminal, and a non-terminal row
      // 409-blocks the Epic's next dispatch. Promote that orphan to `failed`
      // (no-op for any row past `pending`) before broadcasting, so the wire frame
      // and the freed-reservation/auto-dispatch trigger see the terminal row (#179).
      if (state === "failed") promotePendingToFailed(db, event.executionId);
      broadcastWorkflow(event.executionId, state);
    }
  });
  // Source 2: middle's DB-only states bunqueue never emits (waiting-human, the
  // handoff `completed`). The observer fires after each updateWorkflow write.
  const disposeWorkflowObserver = addWorkflowObserver((id, patch) => {
    if (patch.state) broadcastWorkflow(id, patch.state);
  });
  void disposeWorkflowObserver; // daemon clears all observers on shutdown

  const version = readVersion();

  // Per-repo checkout registry: `/control/dispatch` carries `repoPath` (the daemon
  // has no inherent knowledge of where a repo lives); the workflow's
  // resolveRepoPath reads it. In-memory for the hot path, but **hydrated from the
  // durable `repo_config` registry on startup** (and written back on every learn,
  // below) so a restarted daemon — and the recommender cron — know every managed
  // repo without waiting for a fresh dispatch (#135).
  const repoPaths = new Map<string, string>();
  for (const managed of listManagedRepos(db)) repoPaths.set(managed.repo, managed.checkoutPath);

  // Persist a learned checkout path to the durable registry + the in-memory map.
  const rememberRepoPath = (repo: string, repoPath: string): void => {
    repoPaths.set(repo, repoPath);
    registerManagedRepo(db, repo, repoPath);
  };

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
      rememberRepoPath(input.repo, input.repoPath);
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

  /** Force-dispatch an Epic (the dashboard's button + a future API). Mirrors the
   *  control-route gates: 400 (unknown repo/adapter), 429 (no slot), 409 (collision). */
  async function dispatchEpicManual(
    repo: string,
    epicNumber: number,
    adapter: string,
  ): Promise<{ status: number; body: string }> {
    const normalizedRepo = repo.trim();
    const repoPath = repoPaths.get(normalizedRepo);
    if (repoPath === undefined) {
      return { status: 400, body: JSON.stringify({ error: `unknown repo: ${normalizedRepo}` }) };
    }
    const reject = adapterRejectionReason(adapter);
    if (reject !== null) {
      return { status: 400, body: JSON.stringify({ error: reject }) };
    }
    const input = { repo: normalizedRepo, repoPath, epicNumber, adapter };
    if (!slotAvailable(input)) {
      return {
        status: 429,
        body: JSON.stringify({ error: `no free slot for ${adapter} in ${normalizedRepo}` }),
      };
    }
    const workflowId = await startDispatchImpl(input, "manual");
    if (workflowId === null) {
      return {
        status: 409,
        body: JSON.stringify({
          error: `Epic #${epicNumber} in ${normalizedRepo} already has an active workflow`,
        }),
      };
    }
    scheduleAutoDispatch(normalizedRepo);
    void refreshEpics(db, normalizedRepo, ghGitHub).catch((error: unknown) => {
      console.error(
        `[epics] post-dispatch refresh ${normalizedRepo} failed: ${(error as Error).message}`,
      );
    }); // best-effort cache refresh after dispatch
    return { status: 200, body: JSON.stringify({ workflowId }) };
  }

  /** Refresh a repo's Epic cache on demand (the dashboard's refresh affordance). */
  async function refreshEpicsForRepo(repo: string): Promise<{ status: number; body: string }> {
    const normalizedRepo = repo.trim();
    if (!repoPaths.has(normalizedRepo)) {
      return { status: 404, body: JSON.stringify({ error: `unknown repo: ${normalizedRepo}` }) };
    }
    try {
      await refreshEpics(db, normalizedRepo, ghGitHub);
      return { status: 200, body: JSON.stringify({ ok: true }) };
    } catch (error) {
      return { status: 502, body: JSON.stringify({ error: (error as Error).message }) };
    }
  }

  // Trigger #3: any rate-limit state change re-runs auto-dispatch for every known
  // repo (rate-limit state is cross-repo, keyed by adapter — a reset can unblock
  // ready work anywhere).
  const disposeRateLimitObserver = addRateLimitObserver(() => {
    for (const repo of repoPaths.keys()) scheduleAutoDispatch(repo);
  });
  void disposeRateLimitObserver; // daemon clears all observers on shutdown

  // Run the recommender for a repo by checkout path. The recommender runs on the
  // daemon's OWN long-lived engine (registered below), exactly like dispatch —
  // NOT a second ephemeral engine/HookServer (the old standalone path collided
  // with the daemon's port and its in-process second engine never processed the
  // job). This resolves the run input (slug, state-issue number, adapter),
  // registers the repo, then `engine.start("recommender", …)`. On a clean run the
  // workflow's trigger-auto-dispatch step fires `scheduleAutoDispatch` back into
  // this same engine (Trigger #1). Shared by the `/trigger/recommender` route and
  // the cron, so both behave identically. Returns once enqueued.
  async function runRecommenderForRepo(
    repoPath: string,
  ): Promise<{ status: number; body: string }> {
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
    rememberRepoPath(resolved.options.repoSlug, repoPath);
    try {
      await engine.start("recommender", {
        repo: resolved.options.repoSlug,
        stateIssue: resolved.options.stateIssue,
        adapter: resolved.options.adapterName,
      });
    } catch (error) {
      return { status: 500, body: `recommender enqueue failed: ${(error as Error).message}` };
    }
    return { status: 202, body: "recommender run started" };
  }

  // Dashboard "run recommender now" trigger (build spec → Phase 7).
  const recommenderTrigger: RecommenderTrigger = async ({ repoPath }) => {
    if (!repoPath) return { status: 400, body: "repoPath required" };
    return runRecommenderForRepo(repoPath);
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
        // The control-route guard mirrors `dispatchEpicManual` — only configured,
        // enabled, implemented adapters are dispatchable from `/control/dispatch`,
        // and the message distinguishes "unknown" from "disabled" identically.
        adapterRejection: adapterRejectionReason,
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
        try {
          const hosted = opts.hostExtras({
            db,
            config,
            stateGateway: ghStateIssueGateway,
            runRecommender: async (repo: string) => {
              const path = repoPaths.get(repo);
              if (path === undefined) return { status: 404, body: `no checkout for ${repo}` };
              return recommenderTrigger({ repoPath: path });
            },
            dispatch: (repo, epicNumber, adapter) => dispatchEpicManual(repo, epicNumber, adapter),
            refreshEpics: (repo) => refreshEpicsForRepo(repo),
          });
          extraRoutes = hosted.routes;
          hostDispose = hosted.dispose;
        } catch (error) {
          // The dashboard mount is best-effort: a wiring failure must never take
          // down the dispatcher (the critical service). Log and run without it.
          console.error(
            `[main] hostExtras failed — running without the dashboard: ${(error as Error).message}`,
          );
        }
      }
      hookServer.start(config.global.dispatcherPort, extraRoutes);
      return { sessionGate: hookServer, dispatcherUrl: `http://127.0.0.1:${hookServer.port}` };
    },
  });

  // Register before announcing readiness: a `/control/dispatch` request is only
  // serviced on a later event-loop tick, by which point the workflow is registered.
  engine.register(createImplementationWorkflow(deps));

  // Register the RECOMMENDER on this same long-lived engine (not a second
  // ephemeral one) — so `runRecommenderForRepo`'s `engine.start("recommender")`
  // actually runs, reusing the daemon's HookServer/sessionGate + dispatcherUrl.
  // Per-repo settings/context resolve from the input repo's config at run time
  // (`resolveRunSettings`/`gatherContext`), so one registration serves every
  // managed repo — mirroring how the implementation workflow resolves per-repo.
  engine.register(
    createRecommenderWorkflow({
      db,
      getAdapter,
      sessionGate: deps.sessionGate,
      tmux: { newSession, sendText, sendEnter, killSession },
      worktree: { createWorktree, destroyWorktree },
      resolveRepoPath: (repo) => {
        const path = repoPaths.get(repo);
        if (path === undefined) throw new Error(`no checkout path registered for repo ${repo}`);
        return path;
      },
      worktreeRoot: config.global.worktreeRoot,
      dispatcherUrl: deps.dispatcherUrl,
      stateIssue: ghStateIssueGateway,
      surfaceProblem: ghSurfaceProblem,
      triggerAutoDispatch: async ({ repo }) => scheduleAutoDispatch(repo),
      gatherContext: (repo) => {
        const cfg = loadRepoConfig(repo);
        if (!cfg) throw new Error(`recommender: no config for repo ${repo}`);
        return buildRecommenderContext({
          db,
          repo,
          adapters: Object.keys(cfg.adapters),
          maxPerAdapter: cfg.limits?.maxConcurrentPerAdapter ?? {},
          repoMax: cfg.limits?.maxConcurrent ?? cfg.global.maxConcurrent,
          globalMax: cfg.global.maxConcurrent,
        });
      },
      resolveRunSettings: (repo) => {
        const repoPath = repoPaths.get(repo);
        const cfg = loadRepoConfig(repo);
        if (repoPath === undefined || !cfg) {
          throw new Error(`recommender: repo ${repo} is not registered/configured`);
        }
        return {
          // Resolved from the middle install, not repoPath — see issue #107.
          schemaPath: STATE_ISSUE_SCHEMA_PATH,
          config: {
            defaultAdapter: cfg.global.defaultAdapter,
            autoDispatch: cfg.recommender?.autoDispatch ?? false,
            prMode: cfg.repo?.prMode ?? "worktree",
          },
          repoConfig: { adapters: Object.keys(cfg.adapters) },
          agentTimeoutMs: cfg.recommender?.agentTimeoutMs,
        };
      },
    }),
  );

  // Durable recovery (#116): the workflow store survived this restart. Drop
  // mid-drive (`running`/`compensating`) executions — re-driving them would
  // double-launch a session that the restart left alive; their rows are the
  // watchdog's domain — then re-arm parked `waiting` executions so the poller can
  // resume them. Runs AFTER the registers (recover needs the definitions) and
  // BEFORE the poller (so it never signals an exec recover hasn't re-armed).
  const recovery = await recoverEngine(engine);
  if (recovery.cleared > 0 || recovery.recovered.total > 0) {
    console.log(
      `[recover] dropped ${recovery.cleared} mid-drive exec(s); re-armed ${recovery.recovered.waiting} parked / ${recovery.recovered.total} total`,
    );
  }
  // Reconcile orphaned signals: a parked `waiting-human` row whose execution the
  // store no longer has (a park from before persistence shipped, or a wiped queue
  // db) can never resume — finalize it and surface it so the poller stops firing
  // at a dead execution and the work isn't silently stuck.
  const orphans = await reconcileOrphanedSignals({
    db,
    hasExecution: (id) => engine.getExecution(id) !== null,
    surface: ({ workflowId, repo, epicNumber, signalName }) => {
      console.error(
        `[recover] orphaned parked signal '${signalName}' for ${repo}#${epicNumber ?? "?"} (workflow ${workflowId}) — no recoverable execution; finalized failed`,
      );
      if (epicNumber === null) return;
      return ghGitHub
        .postComment(
          repo,
          epicNumber,
          `⚠️ middle could not recover this Epic's parked workflow after a daemon restart (no durable execution for \`${workflowId}\`). The run was finalized as \`failed\`; re-dispatch the Epic to continue.`,
        )
        .catch((error: unknown) => {
          console.error(
            `[recover] orphan Epic comment for ${repo}#${epicNumber} failed: ${(error as Error).message}`,
          );
        });
    },
  });
  if (orphans.length > 0) {
    console.error(`[recover] reconciled ${orphans.length} orphaned parked signal(s)`);
  }

  // Watchdog cron: every 30s, correct transcript drift, rescue an agent stuck on
  // a Notification (#128), then reconcile every launching/running workflow
  // (launch-timeout, tmux liveness, idle detection, sentinel re-arm). The
  // reconcile logic is adapter-agnostic via getAdapter. capturePane/sendText/
  // sendEnter back the notification failsafe's capture + nudge.
  const stopWatchdog = await startWatchdog({
    db,
    tmux: { status, killSession, capturePane, sendText, sendEnter },
    getAdapter,
  });

  // Open-PR divergence reconciler (Epic #168). Sweep every known managed repo
  // for open PRs that drifted from main; rebase first, -X ours merge fallback
  // second, demote-to-work as the escalation. Composed across the existing
  // `ghGitHub` (comment ops) and the reconciler-specific `ghReconcilerGateway`
  // (head ref, mergeability, draft conversion, sub-issue listing, reopen).
  // Re-enqueue routes through the recommender so ranking still applies.
  const reconcilerGithub = { ...ghGitHub, ...ghReconcilerGateway };
  async function reconcileOpenPRsForRepo(repo: string): Promise<void> {
    const repoPath = repoPaths.get(repo);
    if (repoPath === undefined) return;
    try {
      const result = await reconcileOpenPRs(
        {
          db,
          github: reconcilerGithub,
          git: gitOps,
          resolveRepoPath: () => repoPath,
          worktreeRoot: config.global.worktreeRoot,
          enqueueEpic: async (r, epicNumber) => {
            const result = await runRecommenderForRepo(repoPaths.get(r) ?? repoPath);
            if (result.status >= 400) {
              console.error(
                `[pr-divergence] re-enqueue recommender for ${r} #${epicNumber} failed (${result.status}): ${result.body}`,
              );
            }
            scheduleAutoDispatch(r);
          },
          getRateLimit: () => ghPollGateway.getRateLimit(),
        },
        repo,
      );
      if (result.reconciled > 0 || result.skippedForBudget) {
        console.log(
          `[pr-divergence] ${repo}: reconciled=${result.reconciled} passed=${result.passed} skippedForBudget=${result.skippedForBudget}`,
        );
      }
    } catch (error) {
      console.error(`[pr-divergence] ${repo} failed: ${(error as Error).message}`);
    }
  }

  // GitHub poller: every POLLER_INTERVAL_MS (the pinned constant in
  // poller-cron.ts; the dispatcher's CLAUDE.md cadence contract holds it
  // and this doc in sync), for each parked workflow with an armed wait,
  // fire its resume signal when the unblocking event appears (a human reply,
  // or a PR review verdict). `fireSignal` delivers it to this engine — the
  // one that now hosts the parked executions, so review-resume actually fires.
  // Each tick also runs the checkbox-revert trigger (#101) over running
  // workflows whose Epic PR head SHA advanced, and the open-PR divergence
  // reconciler (Epic #168) once per managed repo; a MERGED-transition
  // observed inside `reconcileMergedParks` additionally triggers an immediate
  // sibling sweep so siblings aren't left stale for up to a full interval.
  const stopPoller = await startPoller(
    {
      db,
      github: ghPollGateway,
      fireSignal: (workflowId, payload) => engine.signal(workflowId, RESUME_EVENT, payload),
      // Reconcile pass: when a parked Epic's PR has merged/closed, finalize the row
      // and best-effort tear down its worktree (repo checkout from the registry).
      removeWorktree: (repo, worktreePath) =>
        worktreePath
          ? pruneWorktreeAt(repoPaths.get(repo) ?? null, worktreePath)
          : Promise.resolve(),
    },
    {
      // Checkbox-revert trigger (#101): each tick, over running workflows whose
      // Epic PR head SHA advanced, run the declared gates and revert a failing
      // Status checkbox. Uses the write-capable `gh` gateway (body edits + the
      // revert comment) and the free rate-limit read shared with the poller.
      checkboxRevert: {
        db,
        github: ghGitHub,
        getRateLimit: () => ghPollGateway.getRateLimit(),
      },
      // Open-PR divergence reconciler (Epic #168) — wired to the per-tick sweep
      // and the immediate-on-MERGED hook so siblings of a just-landed Epic PR
      // are reconciled at the moment of merge rather than up to a tick later.
      // Per-pass dedup lives inside `reconcileMergedParks` (the natural boundary;
      // a caller-side timer would race against the loop's await points). Here we
      // just forward to the per-repo sweep — at most one fire per repo per pass
      // is already guaranteed by the upstream contract.
      reconcilers: {
        perTickSweep: async () => {
          for (const repo of repoPaths.keys()) {
            await reconcileOpenPRsForRepo(repo);
          }
        },
        onMergedTransition: (repo) => reconcileOpenPRsForRepo(repo),
      },
    },
  );

  // Recommender cron (#135): every minute, run the recommender for each managed
  // repo whose `[recommender] interval_minutes` has elapsed — the periodic source
  // that drives auto-dispatch without a manual trigger, turning `mm start` into
  // set-and-forget. Reads the durable managed-repo registry, so it works cold
  // (post-restart) and for any repo `mm init` registered.
  const recommenderCronDeps = {
    db,
    loadRepoConfig: (checkoutPath: string) => {
      try {
        return loadConfig({
          globalPath: process.env.MIDDLE_CONFIG,
          repoPath: join(checkoutPath, ".middle", "config.toml"),
        });
      } catch {
        return null; // unreadable config → skip this repo this tick
      }
    },
    runRecommender: async ({ checkoutPath }: { checkoutPath: string }) => {
      // A non-202 means the run never launched (bad config / unresolvable repo) —
      // surface it as an error so the cron's per-repo catch logs it (and rolls the
      // stamp back, so the failure retries next tick rather than going quiet for a
      // full interval).
      const result = await runRecommenderForRepo(checkoutPath);
      if (result.status !== 202) {
        throw new Error(`recommender launch failed (${result.status}): ${result.body}`);
      }
    },
  };
  const stopRecommenderCron = await startRecommenderCron(recommenderCronDeps);

  // Standing backlog audit (Epic #143): an hourly sweep that flags open feature
  // issues whose acceptance criteria fail the integration rubric `needs-design`.
  const stopAuditCron = await startAuditCron({ db, github: ghGitHub });

  // Anti-staleness reconciliation (Epic #143): an hourly sweep that closes
  // landed-but-open issues (with an evidence comment) and files proposal-first
  // tasks for spec lines describing a now-merged phase as future work. Each repo's
  // spec path comes from its own `[staleness] spec_path` (#164), layered on the
  // same global config the daemon booted with.
  const stopStalenessCron = await startStalenessCron({
    db,
    github: ghGitHub,
    globalConfigPath: process.env.MIDDLE_CONFIG,
  });

  // Startup kick: don't idle until the first cron tick / next interval. Run one
  // recommender due-check pass NOW — any overdue managed repo fires immediately
  // (then auto-dispatch on completion) instead of waiting up to the cron interval.
  // And nudge auto-dispatch for every managed repo so an already-ready state issue
  // (from a prior run) drains on restart without needing a fresh recommender pass.
  for (const managed of listManagedRepos(db)) scheduleAutoDispatch(managed.repo);
  void runRecommenderCronPass(recommenderCronDeps).catch((error: unknown) => {
    console.error(`[recommender-cron] startup pass failed: ${(error as Error).message}`);
  });

  // Epic-cache refresh: an initial pass + a fixed-cadence sweep over every known
  // repo. Best-effort — a GitHub hiccup logs and the next tick retries.
  // Ticks are fire-and-forget per repo: a GitHub call slower than the interval
  // can overlap the next tick, which is fine — refreshEpics wraps its writes in a
  // single transaction, so SQLite serializes same-repo writes and each call
  // independently completes-or-logs without corrupting the cache.
  function refreshAllEpics(): void {
    for (const repo of repoPaths.keys()) {
      void refreshEpics(db, repo, ghGitHub).catch((e: unknown) =>
        console.error(`[epics] refresh ${repo} failed: ${(e as Error).message}`),
      );
    }
  }
  refreshAllEpics();
  const epicsTimer = setInterval(refreshAllEpics, EPICS_REFRESH_INTERVAL_MS);

  console.log(`middle dispatcher up — hooks on :${hookServer.port}, db ${config.global.dbPath}`);

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Guard each teardown so a throw/rejection can't skip process.exit.
    clearWorkflowObservers();
    clearRateLimitObservers();
    try {
      hostDispose?.();
    } catch (error) {
      console.error(`shutdown: host dispose failed — ${(error as Error).message}`);
    }
    for (const timer of autoDispatchTimers.values()) clearTimeout(timer);
    autoDispatchTimers.clear();
    clearInterval(epicsTimer);
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
      await stopRecommenderCron();
    } catch (error) {
      console.error(`shutdown: stopRecommenderCron failed — ${(error as Error).message}`);
    }
    try {
      await stopAuditCron();
    } catch (error) {
      console.error(`shutdown: stopAuditCron failed — ${(error as Error).message}`);
    }
    try {
      await stopStalenessCron();
    } catch (error) {
      console.error(`shutdown: stopStalenessCron failed — ${(error as Error).message}`);
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
