import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { MiddleConfig } from "@middle/core";
import { openAndMigrate } from "../src/db.ts";
import {
  getLastRecommenderRun,
  type ManagedRepo,
  registerManagedRepo,
  setPausedUntil,
} from "../src/repo-config.ts";
import { runRecommenderCronPass } from "../src/recommender-cron.ts";

let db: Database;

beforeEach(() => {
  db = openAndMigrate(":memory:");
});

afterEach(() => {
  db.close();
});

const NOW = 10_000_000;

/** A config stub exposing only the `[recommender]` block the cron reads. */
function config(over: { enabled?: boolean; intervalMinutes?: number } = {}): MiddleConfig {
  return {
    recommender: {
      enabled: over.enabled ?? true,
      intervalMinutes: over.intervalMinutes ?? 60,
      adapter: "claude",
      autoDispatch: false,
    },
  } as MiddleConfig;
}

/** Cron deps with a config map (by checkout path) and a recorder of fired runs. */
function makeDeps(
  configByPath: Record<string, MiddleConfig | null>,
  opts: { now?: number; onRun?: (r: ManagedRepo) => void; throwFor?: string } = {},
) {
  const fired: string[] = [];
  const deps = {
    db,
    now: () => opts.now ?? NOW,
    loadRepoConfig: (checkoutPath: string) => configByPath[checkoutPath] ?? null,
    runRecommender: async (r: ManagedRepo) => {
      opts.onRun?.(r);
      if (opts.throwFor === r.repo) throw new Error("recommender run boom");
      fired.push(r.repo);
    },
  };
  return { deps, fired };
}

describe("runRecommenderCronPass", () => {
  test("fires a due, enabled, unpaused repo and stamps last_recommender_run", async () => {
    registerManagedRepo(db, "o/r", "/co/r");
    const { deps, fired } = makeDeps({ "/co/r": config({ intervalMinutes: 60 }) });

    expect(await runRecommenderCronPass(deps)).toBe(1);
    expect(fired).toEqual(["o/r"]);
    expect(getLastRecommenderRun(db, "o/r")).toBe(NOW);
  });

  test("does not re-fire a repo whose interval hasn't elapsed", async () => {
    registerManagedRepo(db, "o/r", "/co/r");
    // last run was 30 min ago; interval is 60 min → not due.
    db.run("UPDATE repo_config SET last_recommender_run = ? WHERE repo = ?", [
      NOW - 30 * 60_000,
      "o/r",
    ]);
    const { deps, fired } = makeDeps({ "/co/r": config({ intervalMinutes: 60 }) });
    expect(await runRecommenderCronPass(deps)).toBe(0);
    expect(fired).toEqual([]);
  });

  test("fires once the interval has elapsed", async () => {
    registerManagedRepo(db, "o/r", "/co/r");
    db.run("UPDATE repo_config SET last_recommender_run = ? WHERE repo = ?", [
      NOW - 61 * 60_000,
      "o/r",
    ]);
    const { deps } = makeDeps({ "/co/r": config({ intervalMinutes: 60 }) });
    expect(await runRecommenderCronPass(deps)).toBe(1);
  });

  test("skips a paused repo", async () => {
    registerManagedRepo(db, "o/r", "/co/r");
    setPausedUntil(db, "o/r", NOW + 60_000, NOW);
    const { deps, fired } = makeDeps({ "/co/r": config() });
    expect(await runRecommenderCronPass(deps)).toBe(0);
    expect(fired).toEqual([]);
  });

  test("skips a repo whose recommender is disabled or unconfigured", async () => {
    registerManagedRepo(db, "off/repo", "/co/off");
    registerManagedRepo(db, "no/rec", "/co/norec");
    const { deps } = makeDeps({
      "/co/off": config({ enabled: false }),
      "/co/norec": {} as MiddleConfig, // no [recommender] block
    });
    expect(await runRecommenderCronPass(deps)).toBe(0);
  });

  test("skips a repo with a non-positive interval (never auto-runs)", async () => {
    registerManagedRepo(db, "o/r", "/co/r");
    const { deps } = makeDeps({ "/co/r": config({ intervalMinutes: 0 }) });
    expect(await runRecommenderCronPass(deps)).toBe(0);
    expect(getLastRecommenderRun(db, "o/r")).toBeNull(); // never stamped
  });

  test("a failed launch rolls the stamp back (retries next tick) and is isolated", async () => {
    registerManagedRepo(db, "bad/repo", "/co/bad");
    registerManagedRepo(db, "good/repo", "/co/good");
    const { deps, fired } = makeDeps(
      { "/co/bad": config(), "/co/good": config() },
      { throwFor: "bad/repo" },
    );
    // bad/repo throws but is isolated; good/repo still fires.
    expect(await runRecommenderCronPass(deps)).toBe(1);
    expect(fired).toEqual(["good/repo"]);
    // The failed launch rolled its stamp back to the prior value (null = never
    // ran) — so it doesn't go quiet for a full interval; the next pass retries it.
    expect(getLastRecommenderRun(db, "bad/repo")).toBeNull();
    expect(getLastRecommenderRun(db, "good/repo")).toBe(NOW); // the success stays stamped

    // Next pass at the same time: bad/repo is due again (retried), good/repo isn't.
    const retried: string[] = [];
    const second = makeDeps(
      { "/co/bad": config(), "/co/good": config() },
      { throwFor: "bad/repo", onRun: (r) => retried.push(r.repo) },
    );
    await runRecommenderCronPass(second.deps);
    expect(retried).toEqual(["bad/repo"]); // only the rolled-back repo retries
  });

  test("ignores unmanaged rows (no checkout path)", async () => {
    setPausedUntil(db, "ghost/repo"); // a row with null checkout_path
    const { deps } = makeDeps({});
    expect(await runRecommenderCronPass(deps)).toBe(0);
  });
});
