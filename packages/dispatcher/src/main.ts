// @middle/dispatcher — the long-running dispatcher process.
//
// Phase 1 scope: open the SQLite db (migrated), stand up the minimal hook
// receiver, create the bunqueue engine, and idle until signalled. The auto-
// dispatch loop, watchdog, and reconciler crons land in Phase 2+. `mm start`
// spawns this; `mm stop` sends it SIGTERM.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { claudeAdapter } from "@middle/adapter-claude";
import type { AgentAdapter } from "@middle/core";
import { loadConfig } from "@middle/core";
import { Engine } from "bunqueue/workflow";
import { openAndMigrate } from "./db.ts";
import { HookServer } from "./hook-server.ts";
import { DbHookStore } from "./hook-store.ts";
import { ghPollGateway } from "./poller-gateway.ts";
import { startPoller } from "./poller-cron.ts";
import { killSession, status } from "./tmux.ts";
import { startWatchdog } from "./watchdog-cron.ts";
import { RESUME_EVENT } from "./workflows/implementation.ts";

/** Phase 2 adapter registry — only `claude` is implemented. */
function getAdapter(name: string): AgentAdapter {
  if (name !== "claude") throw new Error(`unknown adapter: ${name}`);
  return claudeAdapter;
}

async function main(): Promise<void> {
  const config = loadConfig({ globalPath: process.env.MIDDLE_CONFIG });

  mkdirSync(dirname(config.global.dbPath), { recursive: true });
  const db = openAndMigrate(config.global.dbPath);

  const hookServer = new HookServer(new DbHookStore(db));
  hookServer.start(config.global.dispatcherPort);

  // In-memory engine for Phase 1 — durable queue persistence + crash recovery
  // arrive with the watchdog/reconciler in Phase 2.
  const engine = new Engine({ embedded: true });

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
  // review verdict). `fireSignal` delivers it to the engine that hosts the
  // parked execution. NOTE: routing dispatches through this long-lived engine
  // (so parked executions live here to be resumed) is the Phase 8 auto-dispatch
  // integration; the poller + signal seam are in place ahead of it.
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
    // Guard each teardown so a throw/rejection can't skip process.exit and
    // leak as an unhandledRejection (there's no swallower in this entrypoint).
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
