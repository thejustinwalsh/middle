import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openAndMigrate } from "../src/db.ts";
import {
  assertNoRepoPathCollision,
  clearPaused,
  getLastRecommenderRun,
  getManagedRepoPath,
  getPausedUntil,
  isPaused,
  listManagedRepos,
  markRecommenderRun,
  registerManagedRepo,
  RepoPathCollisionError,
  setLastRecommenderRun,
  setPausedUntil,
} from "../src/repo-config.ts";

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

describe("managed-repo registry (#135)", () => {
  test("an unregistered repo has no path and isn't listed", () => {
    expect(getManagedRepoPath(db, "o/r")).toBeNull();
    expect(listManagedRepos(db)).toEqual([]);
  });

  test("registerManagedRepo records the checkout path and lists it", () => {
    registerManagedRepo(db, "o/r", "/checkouts/r");
    expect(getManagedRepoPath(db, "o/r")).toBe("/checkouts/r");
    expect(listManagedRepos(db)).toEqual([{ repo: "o/r", checkoutPath: "/checkouts/r" }]);
  });

  test("registering is idempotent and updates the path in place (one row)", () => {
    registerManagedRepo(db, "o/r", "/old");
    registerManagedRepo(db, "o/r", "/new");
    expect(getManagedRepoPath(db, "o/r")).toBe("/new");
    const { n } = db.query("SELECT count(*) AS n FROM repo_config WHERE repo = ?").get("o/r") as {
      n: number;
    };
    expect(n).toBe(1);
  });

  test("registering preserves an existing pause (doesn't clobber paused_until)", () => {
    setPausedUntil(db, "o/r", 9999, 0);
    registerManagedRepo(db, "o/r", "/checkouts/r");
    expect(getPausedUntil(db, "o/r")).toBe(9999); // pause survived the registry write
    expect(getManagedRepoPath(db, "o/r")).toBe("/checkouts/r");
  });

  test("listManagedRepos excludes rows with no checkout path (e.g. a pause-only row)", () => {
    setPausedUntil(db, "paused/only"); // creates a row with null checkout_path
    registerManagedRepo(db, "managed/repo", "/checkouts/m");
    expect(listManagedRepos(db)).toEqual([{ repo: "managed/repo", checkoutPath: "/checkouts/m" }]);
  });

  test("setLastRecommenderRun writes a value and clears it with null (cron rollback)", () => {
    setLastRecommenderRun(db, "o/r", 1_700_000);
    expect(getLastRecommenderRun(db, "o/r")).toBe(1_700_000);
    setLastRecommenderRun(db, "o/r", null); // roll back to "never ran"
    expect(getLastRecommenderRun(db, "o/r")).toBeNull();
  });

  test("markRecommenderRun stamps and reads back last_recommender_run", () => {
    expect(getLastRecommenderRun(db, "o/r")).toBeNull();
    markRecommenderRun(db, "o/r", 1_700_000);
    expect(getLastRecommenderRun(db, "o/r")).toBe(1_700_000);
    // It coexists with a registered path on the same row.
    registerManagedRepo(db, "o/r", "/checkouts/r");
    expect(getLastRecommenderRun(db, "o/r")).toBe(1_700_000);
    expect(getManagedRepoPath(db, "o/r")).toBe("/checkouts/r");
  });
});

// #226 — two repo slugs must never share one checkout path: the second's
// dispatches collide on `git worktree add`. registerManagedRepo (and the explicit
// guard) rejects it; a same-slug re-register stays idempotent.
describe("shared-checkout collision guard (#226)", () => {
  test("(a) registering acme/a at /tmp/X succeeds", () => {
    registerManagedRepo(db, "acme/a", "/tmp/X");
    expect(getManagedRepoPath(db, "acme/a")).toBe("/tmp/X");
  });

  test("(b) re-registering the SAME repo at the same path is idempotent and succeeds", () => {
    registerManagedRepo(db, "acme/a", "/tmp/X");
    expect(() => registerManagedRepo(db, "acme/a", "/tmp/X")).not.toThrow();
    const { n } = db
      .query("SELECT count(*) AS n FROM repo_config WHERE repo = ?")
      .get("acme/a") as {
      n: number;
    };
    expect(n).toBe(1);
  });

  test("(c) registering a DIFFERENT repo at the same path rejects, naming both repos + the path", () => {
    registerManagedRepo(db, "acme/a", "/tmp/X");
    let caught: unknown;
    try {
      registerManagedRepo(db, "acme/b", "/tmp/X");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RepoPathCollisionError);
    const err = caught as RepoPathCollisionError;
    expect(err.existingRepo).toBe("acme/a");
    expect(err.attemptedRepo).toBe("acme/b");
    expect(err.checkoutPath).toBe("/tmp/X");
    expect(err.message).toContain("acme/a");
    expect(err.message).toContain("acme/b");
    expect(err.message).toContain("/tmp/X");
  });

  test("the rejected repo is NOT written (the collision guard runs before the insert)", () => {
    registerManagedRepo(db, "acme/a", "/tmp/X");
    expect(() => registerManagedRepo(db, "acme/b", "/tmp/X")).toThrow(RepoPathCollisionError);
    // acme/b never got a row; acme/a still owns the path.
    expect(getManagedRepoPath(db, "acme/b")).toBeNull();
    expect(listManagedRepos(db)).toEqual([{ repo: "acme/a", checkoutPath: "/tmp/X" }]);
  });

  test("the same repo can move to a new path (no self-collision)", () => {
    registerManagedRepo(db, "acme/a", "/tmp/X");
    registerManagedRepo(db, "acme/a", "/tmp/Y");
    expect(getManagedRepoPath(db, "acme/a")).toBe("/tmp/Y");
    // And another repo can then claim the now-freed /tmp/X.
    expect(() => registerManagedRepo(db, "acme/b", "/tmp/X")).not.toThrow();
  });

  test("assertNoRepoPathCollision is a standalone guard (used by mm init before scaffolding)", () => {
    registerManagedRepo(db, "acme/a", "/tmp/X");
    expect(() => assertNoRepoPathCollision(db, "acme/b", "/tmp/X")).toThrow(RepoPathCollisionError);
    expect(() => assertNoRepoPathCollision(db, "acme/a", "/tmp/X")).not.toThrow(); // same repo ok
    expect(() => assertNoRepoPathCollision(db, "acme/c", "/tmp/Z")).not.toThrow(); // free path ok
  });
});
