import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openAndMigrate } from "../src/db.ts";
import { clearPaused, getPausedUntil, isPaused, setPausedUntil } from "../src/repo-config.ts";

// Per-repo pause/resume state (#51): `mm pause` sets repo_config.paused_until,
// `mm resume` clears it, and a paused-until-in-the-future repo reads as paused.

let db: Database;

beforeEach(() => {
  db = openAndMigrate(":memory:");
});

afterEach(() => {
  db.close();
});

describe("repo pause/resume", () => {
  test("an unpaused repo (no row) reads as not paused", () => {
    expect(getPausedUntil(db, "o/r")).toBeNull();
    expect(isPaused(db, "o/r")).toBe(false);
  });

  test("mm pause (indefinite) suspends the repo", () => {
    setPausedUntil(db, "o/r");
    expect(isPaused(db, "o/r")).toBe(true);
    expect(getPausedUntil(db, "o/r")).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("a paused_until in the future reads as paused; in the past auto-expires", () => {
    const now = 1_000_000;
    setPausedUntil(db, "o/r", now + 60_000, now);
    expect(isPaused(db, "o/r", now)).toBe(true);
    // After the timestamp elapses, the pause auto-expires with no cleanup.
    expect(isPaused(db, "o/r", now + 120_000)).toBe(false);
  });

  test("mm resume clears the pause", () => {
    setPausedUntil(db, "o/r");
    clearPaused(db, "o/r");
    expect(getPausedUntil(db, "o/r")).toBeNull();
    expect(isPaused(db, "o/r")).toBe(false);
  });

  test("pausing is idempotent and re-pausing updates the timestamp", () => {
    setPausedUntil(db, "o/r", 5000, 0);
    setPausedUntil(db, "o/r", 9000, 0);
    expect(getPausedUntil(db, "o/r")).toBe(9000);
    // Only one row exists for the repo.
    const count = db.query("SELECT count(*) AS n FROM repo_config WHERE repo = ?").get("o/r") as {
      n: number;
    };
    expect(count.n).toBe(1);
  });

  test("resume on a never-paused repo is a harmless no-op", () => {
    clearPaused(db, "o/r");
    expect(getPausedUntil(db, "o/r")).toBeNull();
  });
});
