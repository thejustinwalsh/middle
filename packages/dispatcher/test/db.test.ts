import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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
  "epics",
  "events",
  "rate_limit_state",
  "repo_config",
  "schema_version",
  "waitfor_signals",
  "workflows",
];

const EXPECTED_INDEXES = [
  "idx_workflows_state",
  "idx_workflows_repo",
  "idx_workflows_heartbeat",
  "idx_events_workflow_ts",
  "idx_events_ts",
  "idx_repo_config_checkout_path",
];

function names(db: Database, type: "table" | "index"): string[] {
  return (
    db.query(`SELECT name FROM sqlite_master WHERE type = ? ORDER BY name`).all(type) as {
      name: string;
    }[]
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

  test("applies every migration and reports the latest version", () => {
    const db = openDb(dbPath);
    expect(runMigrations(db)).toBe(12);
    expect(currentSchemaVersion(db)).toBe(12);
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

  test("is idempotent — running twice leaves version at the latest and does not throw", () => {
    const db = openDb(dbPath);
    runMigrations(db);
    expect(runMigrations(db)).toBe(12);
    expect(currentSchemaVersion(db)).toBe(12);
    db.close();
  });

  test("002 adds the waitfor_signals.fired_at column", () => {
    const db = openAndMigrate(dbPath);
    const cols = (db.query("PRAGMA table_info(waitfor_signals)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("fired_at");
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

  test("003 widens workflows.kind to accept 'documentation' but still rejects unknown kinds", () => {
    const db = openAndMigrate(dbPath);
    db.run(
      `INSERT INTO workflows (id, kind, repo, adapter, state, created_at, updated_at)
       VALUES ('d1', 'documentation', 'o/r', 'claude', 'pending', 0, 0)`,
    );
    expect(
      (db.query("SELECT kind FROM workflows WHERE id = 'd1'").get() as { kind: string }).kind,
    ).toBe("documentation");
    const insertBogus = () =>
      db.run(
        `INSERT INTO workflows (id, kind, repo, adapter, state, created_at, updated_at)
         VALUES ('d2', 'nonsense', 'o/r', 'claude', 'pending', 0, 0)`,
      );
    expect(insertBogus).toThrow();
    db.close();
  });

  test("003 preserves existing rows and child FK references through the table rebuild", () => {
    // Migrate through 002 ONLY (a temp dir with just 001+002), seed a workflow
    // and a child event, then apply the real migrations dir so 003 rebuilds the
    // table over existing data — the path a live db actually takes.
    const realDir = join(import.meta.dir, "..", "src", "db", "migrations");
    const through002 = mkdtempSync(join(tmpdir(), "middle-mig-"));
    try {
      cpSync(join(realDir, "001_initial.sql"), join(through002, "001_initial.sql"));
      cpSync(join(realDir, "002_waitfor_fired.sql"), join(through002, "002_waitfor_fired.sql"));

      const db = openDb(dbPath);
      expect(runMigrations(db, through002)).toBe(2);
      db.run(
        `INSERT INTO workflows (id, kind, repo, adapter, state, created_at, updated_at)
         VALUES ('w1', 'recommender', 'o/r', 'claude', 'completed', 1, 1)`,
      );
      db.run(`INSERT INTO events (workflow_id, ts, type) VALUES ('w1', 2, 'session.started')`);

      // Now apply the remaining migrations (003 rebuild, then 004, 005, 006) over the seeded data.
      expect(runMigrations(db, realDir)).toBe(12);

      // The row survived the rebuild...
      expect(
        (db.query("SELECT kind FROM workflows WHERE id = 'w1'").get() as { kind: string }).kind,
      ).toBe("recommender");
      // ...its child event's FK still resolves to the rebuilt table...
      expect(
        (db.query("SELECT type FROM events WHERE workflow_id = 'w1'").get() as { type: string })
          .type,
      ).toBe("session.started");
      // ...and FK integrity holds across the whole db.
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      db.close();
    } finally {
      rmSync(through002, { recursive: true, force: true });
    }
  });

  test("011 applies over a db that already holds duplicate checkout_path rows (de-dupes first)", () => {
    // A db written before the unique index — by an older daemon or the TOCTOU race
    // 011 closes — can carry two rows at one path. CREATE UNIQUE INDEX over that
    // would abort the whole migration (bricking startup); 011 must de-dupe first.
    const realDir = join(import.meta.dir, "..", "src", "db", "migrations");
    const through010 = mkdtempSync(join(tmpdir(), "middle-mig-"));
    try {
      // Copy migrations 001–010 only → migrate to v10, the pre-index world. Both
      // 011 (the unique index this test exercises) and everything after it must be
      // withheld, so the seeded duplicate state below is legal at this point.
      for (const name of readdirSync(realDir)) {
        const match = /^(\d+)_/.exec(name);
        if (name.endsWith(".sql") && match && Number(match[1]) <= 10) {
          cpSync(join(realDir, name), join(through010, name));
        }
      }
      const db = openDb(dbPath);
      expect(runMigrations(db, through010)).toBe(10);

      // Seed the illegal state: two repos sharing one non-null checkout_path.
      db.run(
        "INSERT INTO repo_config (repo, config_json, checkout_path, last_synced_at) VALUES ('acme/a', '{}', '/tmp/dup', 1)",
      );
      db.run(
        "INSERT INTO repo_config (repo, config_json, checkout_path, last_synced_at) VALUES ('acme/b', '{}', '/tmp/dup', 2)",
      );

      // Applying the real dir (which adds 011) must NOT throw, and must converge.
      expect(runMigrations(db, realDir)).toBe(12);

      // The lowest-rowid row (acme/a) keeps the path; the loser was nulled out.
      const rows = db.query("SELECT repo, checkout_path FROM repo_config ORDER BY repo").all() as {
        repo: string;
        checkout_path: string | null;
      }[];
      expect(rows).toEqual([
        { repo: "acme/a", checkout_path: "/tmp/dup" },
        { repo: "acme/b", checkout_path: null },
      ]);

      // And the index is now enforcing — a re-introduced duplicate is rejected.
      expect(() =>
        db.run(
          "INSERT INTO repo_config (repo, config_json, checkout_path, last_synced_at) VALUES ('acme/c', '{}', '/tmp/dup', 3)",
        ),
      ).toThrow(/UNIQUE constraint failed: repo_config\.checkout_path/);
      db.close();
    } finally {
      rmSync(through010, { recursive: true, force: true });
    }
  });
});

describe("openAndMigrate", () => {
  test("opens, migrates, and returns a ready database", () => {
    const db = openAndMigrate(dbPath);
    expect(currentSchemaVersion(db)).toBe(12);
    db.close();
  });
});
