import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAndMigrate } from "../src/db.ts";

let scratch: string;
let db: Database;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "middle-mig-"));
  db = openAndMigrate(join(scratch, "db.sqlite3"));
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("migration 007 — repo_config epic-store columns", () => {
  test("adds epic_store TEXT NOT NULL DEFAULT 'github'", () => {
    const cols = db.query("PRAGMA table_info(repo_config)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const epicStore = cols.find((c) => c.name === "epic_store");
    expect(epicStore?.type).toBe("TEXT");
    expect(epicStore?.notnull).toBe(1);
    expect(epicStore?.dflt_value).toBe("'github'");
  });

  test("adds epics_dir TEXT (nullable — only set in file mode)", () => {
    const cols = db.query("PRAGMA table_info(repo_config)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const epicsDir = cols.find((c) => c.name === "epics_dir");
    expect(epicsDir?.type).toBe("TEXT");
    expect(epicsDir?.notnull).toBe(0);
  });

  test("adds state_file TEXT (nullable — only set in file mode)", () => {
    const cols = db.query("PRAGMA table_info(repo_config)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const stateFile = cols.find((c) => c.name === "state_file");
    expect(stateFile?.type).toBe("TEXT");
    expect(stateFile?.notnull).toBe(0);
  });

  test("a freshly-inserted row defaults epic_store to 'github'", () => {
    db.run(
      "INSERT INTO repo_config (repo, config_json, last_synced_at) VALUES (?, '{}', ?)",
      ["acme/test", Date.now()],
    );
    const row = db
      .query("SELECT epic_store, epics_dir, state_file FROM repo_config WHERE repo = ?")
      .get("acme/test") as { epic_store: string; epics_dir: string | null; state_file: string | null };
    expect(row.epic_store).toBe("github");
    expect(row.epics_dir).toBeNull();
    expect(row.state_file).toBeNull();
  });
});
