import { existsSync } from "node:fs";
import { loadConfig } from "@middle/core";
import { openDb } from "@middle/dispatcher/src/db.ts";

export type StatusOptions = {
  /** Override the global config path (defaults to `~/.middle/config.toml`). */
  configPath?: string;
  /** Override the database path (defaults to the config's `db_path`). */
  dbPath?: string;
};

type StateCount = { repo: string; state: string; n: number };

/**
 * `mm status` — a one-screen summary of every repo's workflow states, read
 * straight from SQLite. Returns a process exit code: 0 on success, 1 on error.
 */
export function runStatus(opts: StatusOptions = {}): number {
  let dbPath: string;
  try {
    dbPath = opts.dbPath ?? loadConfig({ globalPath: opts.configPath }).global.dbPath;
  } catch (error) {
    console.error(`mm status: failed to load config — ${(error as Error).message}`);
    return 1;
  }

  if (!existsSync(dbPath)) {
    console.log("middle: no dispatcher database yet — nothing in flight.");
    return 0;
  }

  const db = openDb(dbPath);
  try {
    let rows: StateCount[];
    try {
      rows = db
        .query(
          `SELECT repo, state, count(*) AS n
             FROM workflows
            GROUP BY repo, state
            ORDER BY repo, state`,
        )
        .all() as StateCount[];
    } catch {
      console.log("middle: database has no workflows table yet — nothing in flight.");
      return 0;
    }

    if (rows.length === 0) {
      console.log("middle: no workflows recorded.");
      return 0;
    }

    console.log("middle — workflow status");
    let currentRepo = "";
    for (const row of rows) {
      if (row.repo !== currentRepo) {
        console.log(`\n  ${row.repo}`);
        currentRepo = row.repo;
      }
      console.log(`    ${row.state.padEnd(14)} ${row.n}`);
    }
    return 0;
  } finally {
    db.close();
  }
}
