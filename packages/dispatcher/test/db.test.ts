import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentSchemaVersion, openAndMigrate, openDb, runMigrations } from "../src/db.ts";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "middle-db-"));
  dbPath = join(dir, "db.sqlite3");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const EXPECTED_TABLES = [
  "workflows",
  "events",
  "rate_limit_state",
  "repo_config",
  "waitfor_signals",
  "schema_version",
];

const EXPECTED_INDEXES = [
  "idx_workflows_state",
  "idx_workflows_repo",
  "idx_workflows_heartbeat",
  "idx_events_workflow_ts",
  "idx_events_ts",
];

function names(db: Database, type: "table" | "index"): string[] {
  return (
    db
      .query(`SELECT name FROM sqlite_master WHERE type = ? ORDER BY name`)
      .all(type) as { name: string }[]
  ).map((r) => r.name);
}

describe("openDb", () => {
  test("opens a file database in WAL mode", () => {
    const db = openDb(dbPath);
    const mode = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(mode.journal_mode).toBe("wal");
    db.close();
  });
});

describe("runMigrations", () => {
  test("a fresh db starts at schema version 0", () => {
    const db = openDb(dbPath);
    expect(currentSchemaVersion(db)).toBe(0);
    db.close();
  });

  test("applies 001_initial and reports version 1", () => {
    const db = openDb(dbPath);
    expect(runMigrations(db)).toBe(1);
    expect(currentSchemaVersion(db)).toBe(1);
    db.close();
  });

  test("001_initial creates every documented table", () => {
    const db = openDb(dbPath);
    runMigrations(db);
    const tables = names(db, "table");
    for (const t of EXPECTED_TABLES) expect(tables).toContain(t);
    db.close();
  });

  test("001_initial creates every documented index", () => {
    const db = openDb(dbPath);
    runMigrations(db);
    const indexes = names(db, "index");
    for (const i of EXPECTED_INDEXES) expect(indexes).toContain(i);
    db.close();
  });

  test("is idempotent — running twice leaves version at 1 and does not throw", () => {
    const db = openDb(dbPath);
    runMigrations(db);
    expect(runMigrations(db)).toBe(1);
    expect(currentSchemaVersion(db)).toBe(1);
    db.close();
  });

  test("workflows.state CHECK rejects an unknown state", () => {
    const db = openAndMigrate(dbPath);
    const insert = () =>
      db.run(
        `INSERT INTO workflows (id, kind, repo, adapter, state, created_at, updated_at)
         VALUES ('w1', 'implementation', 'o/r', 'claude', 'bogus', 0, 0)`,
      );
    expect(insert).toThrow();
    db.close();
  });

  test("workflows.state CHECK accepts 'launching'", () => {
    const db = openAndMigrate(dbPath);
    db.run(
      `INSERT INTO workflows (id, kind, repo, adapter, state, created_at, updated_at)
       VALUES ('w1', 'implementation', 'o/r', 'claude', 'launching', 0, 0)`,
    );
    const row = db.query("SELECT controlled_by FROM workflows WHERE id = 'w1'").get() as {
      controlled_by: string;
    };
    expect(row.controlled_by).toBe("middle");
    db.close();
  });
});

describe("openAndMigrate", () => {
  test("opens, migrates, and returns a ready database", () => {
    const db = openAndMigrate(dbPath);
    expect(currentSchemaVersion(db)).toBe(1);
    db.close();
  });
});
