import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Default location of the numbered `.sql` migration files. */
export const MIGRATIONS_DIR = join(import.meta.dir, "db", "migrations");

/**
 * Open the SQLite database in WAL mode. Creates the file if absent.
 * WAL is the documented mode for `~/.middle/db.sqlite3`; it lets the dispatcher
 * read while crons and workers write. `:memory:` databases silently stay in
 * "memory" journal mode — tests that assert WAL must use a file path.
 */
export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

/** The highest applied migration version, or 0 if the db has never been migrated. */
export function currentSchemaVersion(db: Database): number {
  const hasTable = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
    .get();
  if (!hasTable) return 0;
  const row = db.query("SELECT max(version) AS v FROM schema_version").get() as {
    v: number | null;
  };
  return row?.v ?? 0;
}

type Migration = { version: number; name: string; sql: string };

/** Load and order the migration files. Each filename must start with `NNN_`. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => {
      const match = /^(\d+)_/.exec(name);
      if (!match) throw new Error(`migration filename missing numeric prefix: ${name}`);
      return { version: Number(match[1]), name, sql: readFileSync(join(dir, name), "utf8") };
    });
}

/**
 * Apply every migration newer than the recorded `schema_version`, each in its
 * own transaction. A migration's SQL may record its own version row (001 does);
 * the `INSERT OR IGNORE` here is the backstop so a migration that omits it is
 * still tracked. Returns the resulting schema version.
 */
export function runMigrations(db: Database, dir: string = MIGRATIONS_DIR): number {
  const applied = currentSchemaVersion(db);
  const pending = loadMigrations(dir).filter((m) => m.version > applied);
  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.sql);
      db.run("INSERT OR IGNORE INTO schema_version (version) VALUES (?)", [migration.version]);
    })();
  }
  return currentSchemaVersion(db);
}

/** Open the database and bring it to the latest schema version in one call. */
export function openAndMigrate(path: string, dir: string = MIGRATIONS_DIR): Database {
  const db = openDb(path);
  runMigrations(db, dir);
  return db;
}
