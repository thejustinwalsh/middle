// @middle/dispatcher — the long-running dispatcher process.
//
// Phase 1 scope: open the SQLite db (migrated), stand up the minimal hook
// receiver, create the bunqueue engine, and idle until signalled. The auto-
// dispatch loop, watchdog, and reconciler crons land in Phase 2+. `mm start`
// spawns this; `mm stop` sends it SIGTERM.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "@middle/core";
import { Engine } from "bunqueue/workflow";
import { openAndMigrate } from "./db.ts";
import { HookServer } from "./hook-server.ts";

async function main(): Promise<void> {
  const config = loadConfig({ globalPath: process.env.MIDDLE_CONFIG });

  mkdirSync(dirname(config.global.dbPath), { recursive: true });
  const db = openAndMigrate(config.global.dbPath);

  const hookServer = new HookServer();
  hookServer.start(config.global.dispatcherPort);

  // In-memory engine for Phase 1 — durable queue persistence + crash recovery
  // arrive with the watchdog/reconciler in Phase 2.
  const engine = new Engine({ embedded: true });

  console.log(
    `middle dispatcher up — hooks on :${hookServer.port}, db ${config.global.dbPath}`,
  );

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    hookServer.stop();
    await engine.close(true);
    db.close();
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
