import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentSchemaVersion, openAndMigrate } from "@middle/dispatcher/src/db.ts";

// End-to-end coverage for scripts/backup.sh + scripts/reset-db.sh: a real
// migrated SQLite db, backed up → reset → restored, asserting the row survives
// the round-trip and the destructive guards hold.

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const BACKUP = join(REPO_ROOT, "scripts", "backup.sh");
const RESET = join(REPO_ROOT, "scripts", "reset-db.sh");

let home: string;
let out: string;

function seedDb(): void {
  const db = openAndMigrate(join(home, "db.sqlite3"));
  db.run(
    `INSERT INTO workflows (id, kind, repo, adapter, state, created_at, updated_at)
     VALUES ('wf-keep', 'implementation', 'o/r', 'claude', 'completed', 1, 1)`,
  );
  db.close();
}

async function run(
  script: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bash", script, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: env ? { ...process.env, ...env } : process.env,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "middle-home-"));
  out = mkdtempSync(join(tmpdir(), "middle-out-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

describe("backup.sh + reset-db.sh round-trip", () => {
  test("backup → reset → restore preserves the db and its rows", async () => {
    seedDb();

    const backup = await run(BACKUP, ["--home", home, "--out", out]);
    expect(backup.code).toBe(0);
    const archives = readdirSync(out).filter((f) => f.endsWith(".tar.gz"));
    expect(archives.length).toBe(1);
    const archive = join(out, archives[0]!);

    const reset = await run(RESET, ["--home", home, "--yes"]);
    expect(reset.code).toBe(0);
    expect(existsSync(join(home, "db.sqlite3"))).toBe(false);
    expect(reset.stdout).toContain("GitHub was not touched");

    const restore = await run(BACKUP, ["--restore", archive, "--home", home, "--yes"]);
    expect(restore.code).toBe(0);
    expect(existsSync(join(home, "db.sqlite3"))).toBe(true);

    // The restored db is intact: schema migrated, and the seeded row survived.
    const db = openAndMigrate(join(home, "db.sqlite3"));
    expect(currentSchemaVersion(db)).toBe(7);
    const row = db.query("SELECT id FROM workflows WHERE id = 'wf-keep'").get();
    expect(row).toEqual({ id: "wf-keep" });
    db.close();
  });
});

describe("safety guards", () => {
  test("backup.sh fails when there is no database", async () => {
    const r = await run(BACKUP, ["--home", home, "--out", out]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("nothing to back up");
  });

  test("reset-db.sh is a no-op (exit 0) when there is no database", async () => {
    const r = await run(RESET, ["--home", home, "--yes"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("nothing to reset");
  });

  test("reset-db.sh refuses while the dispatcher pidfile is live", async () => {
    seedDb();
    // This test process is, by definition, alive — use its own pid as the sentinel.
    writeFileSync(join(home, "dispatcher.pid"), String(process.pid));
    const r = await run(RESET, ["--home", home, "--yes"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("dispatcher is running");
    expect(existsSync(join(home, "db.sqlite3"))).toBe(true); // untouched
  });

  test("--db points both scripts at a relocated database", async () => {
    // A db that does NOT live at <home>/db.sqlite3 — the relocated-db case the
    // config's db_path covers. --home stays a different, empty dir.
    const relocated = join(out, "elsewhere.sqlite3");
    const dbA = openAndMigrate(relocated);
    dbA.run(
      `INSERT INTO workflows (id, kind, repo, adapter, state, created_at, updated_at)
       VALUES ('wf-reloc', 'implementation', 'o/r', 'claude', 'completed', 1, 1)`,
    );
    dbA.close();

    const backup = await run(BACKUP, ["--db", relocated, "--home", home, "--out", out]);
    expect(backup.code).toBe(0);

    const reset = await run(RESET, ["--db", relocated, "--home", home, "--yes"]);
    expect(reset.code).toBe(0);
    expect(existsSync(relocated)).toBe(false); // the relocated db, not <home>/db.sqlite3
  });

  test("restore creates missing parent dirs for a relocated db and config", async () => {
    // Back up a db + config from <home>, then restore into destinations whose
    // parent directories do NOT exist yet (a relocated --db / MIDDLE_CONFIG).
    // Bare `cp` would abort on the missing parents; restore must mkdir -p first.
    seedDb();
    writeFileSync(join(home, "config.toml"), 'default_adapter = "claude"\n');
    const backup = await run(BACKUP, ["--home", home, "--out", out]);
    expect(backup.code).toBe(0);
    const archive = join(out, readdirSync(out).find((f) => f.endsWith(".tar.gz"))!);

    const dbDest = join(out, "no", "such", "dir", "relocated.sqlite3");
    const cfgDest = join(out, "other", "missing", "config.toml");
    const restore = await run(
      BACKUP,
      ["--restore", archive, "--db", dbDest, "--home", join(out, "fresh-home"), "--yes"],
      { MIDDLE_CONFIG: cfgDest },
    );
    expect(restore.code).toBe(0);
    expect(existsSync(dbDest)).toBe(true);
    expect(existsSync(cfgDest)).toBe(true);
    expect(restore.stdout).toContain("restored: config.toml");

    // The relocated db is the real, migrated db with the seeded row intact.
    const db = openAndMigrate(dbDest);
    const row = db.query("SELECT id FROM workflows WHERE id = 'wf-keep'").get();
    expect(row).toEqual({ id: "wf-keep" });
    db.close();
  });

  test("restore refuses while the dispatcher pidfile is live", async () => {
    seedDb();
    await run(BACKUP, ["--home", home, "--out", out]);
    const archive = join(out, readdirSync(out).find((f) => f.endsWith(".tar.gz"))!);
    writeFileSync(join(home, "dispatcher.pid"), String(process.pid));
    const r = await run(BACKUP, ["--restore", archive, "--home", home, "--yes"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("dispatcher is running");
  });
});
