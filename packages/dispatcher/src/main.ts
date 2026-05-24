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
import { buildImplementationDeps } from "./build-deps.ts";
import { installBunqueueRaceSwallower } from "./bunqueue-race.ts";
import { openAndMigrate } from "./db.ts";
import { EventHub } from "./event-hub.ts";
import { type ControlPlane, HookServer } from "./hook-server.ts";
import type { RecommenderTrigger } from "./hook-server.ts";
import { DbHookStore } from "./hook-store.ts";
import { dispatchRecommender, resolveRecommenderOptions } from "./recommender-run.ts";
import { ghPollGateway } from "./poller-gateway.ts";
import { startPoller } from "./poller-cron.ts";
import { killSession, status } from "./tmux.ts";
import { startWatchdog } from "./watchdog-cron.ts";
import {
  getWorkflow,
  hasNonTerminalEpicWorkflow,
  listNonTerminalWorkflows,
  setUpdateWorkflowObserver,
} from "./workflow-record.ts";
import { createImplementationWorkflow, RESUME_EVENT } from "./workflows/implementation.ts";

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

async function main(): Promise<void> {
  const config = loadConfig({ globalPath: process.env.MIDDLE_CONFIG });

  mkdirSync(dirname(config.global.dbPath), { recursive: true });
  const db = openAndMigrate(config.global.dbPath);

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

  // One place that turns a state change into a `workflow` broadcast (repo/epic
  // looked up from the row). Fed by two sources below. They overlap on the
  // states the workflow writes to the row AND bunqueue emits (`completed`,
  // around compensation), so collapse a consecutive identical (id, state) frame
  // — otherwise a normal completion double-broadcasts. NB: the entry is NOT
  // pruned on a terminal state — the duplicate terminal frame from the other
  // source arrives right after, and pruning would let it through. The map grows
  // one tiny entry per execution over the daemon's (in-memory, restartable) life.
  const lastBroadcastState = new Map<string, string>();
  const broadcastWorkflow = (executionId: string, state: string): void => {
    if (lastBroadcastState.get(executionId) === state) return;
    lastBroadcastState.set(executionId, state);
    const row = getWorkflow(db, executionId);
    hub.broadcast({
      type: "workflow",
      data: { id: executionId, repo: row?.repo ?? "", epic: row?.epicNumber ?? null, state },
    });
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

  // Dashboard "run recommender now" trigger (build spec → Phase 7). Read-only:
  // the run rewrites the state issue but `triggerAutoDispatch` stays unwired, so
  // nothing auto-dispatches. The run uses an ephemeral port so it never collides
  // with the live dispatcher's port.
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
    void dispatchRecommender({ ...resolved.options, dispatcherPort: 0 }).catch((error: unknown) => {
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
        hasActiveEpicWorkflow: (repo, epicNumber) => hasNonTerminalEpicWorkflow(db, repo, epicNumber),
        startDispatch: async ({ repo, repoPath, epicNumber, adapter }) => {
          repoPaths.set(repo, repoPath);
          const handle = await engine.start("implementation", { repo, epicNumber, adapter });
          return handle.id;
        },
        initEvents: () =>
          listNonTerminalWorkflows(db).map((w) => ({
            type: "workflow",
            data: { id: w.id, repo: w.repo, epic: w.epicNumber, state: w.state },
          })),
      };
      hookServer = new HookServer(new DbHookStore(db), prReadyGate, recommenderTrigger, control);
      hookServer.start(config.global.dispatcherPort);
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
  });

  console.log(
    `middle dispatcher up — hooks on :${hookServer.port}, db ${config.global.dbPath}`,
  );

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Guard each teardown so a throw/rejection can't skip process.exit.
    setUpdateWorkflowObserver(null);
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

main().catch((error: unknown) => {
  console.error(`middle dispatcher failed: ${(error as Error).message}`);
  process.exit(1);
});
