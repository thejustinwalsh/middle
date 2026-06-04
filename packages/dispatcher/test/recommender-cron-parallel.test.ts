import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { MiddleConfig } from "@middle/core";
import { openAndMigrate } from "../src/db.ts";
import {
  getLastRecommenderRun,
  type ManagedRepo,
  registerManagedRepo,
} from "../src/repo-config.ts";
import { runRecommenderCronPass } from "../src/recommender-cron.ts";

// #227 — the recommender cron fires per-repo runs CONCURRENTLY, each under a hard
// per-repo timeout, so a hung repo can't block the others. The integration here
// drives the real `runRecommenderCronPass` against a real db with stubbed
// `runRecommender` implementations (A fast, B hangs, C fast), observing isolation
// through the per-repo `last_recommender_run` rows and the per-repo write record.

let db: Database;

beforeEach(() => {
  db = openAndMigrate(":memory:");
});

afterEach(() => {
  db.close();
});

const NOW = 10_000_000;

function config(): MiddleConfig {
  return {
    recommender: { enabled: true, intervalMinutes: 60, adapter: "claude", autoDispatch: false },
  } as MiddleConfig;
}

describe("runRecommenderCronPass — per-repo parallelism + timeout (#227)", () => {
  test("a hung repo times out without blocking the others; A+C succeed, B fails", async () => {
    for (const r of ["acme/a", "acme/b", "acme/c"]) registerManagedRepo(db, r, `/co/${r}`);
    const configByPath: Record<string, MiddleConfig> = {
      "/co/acme/a": config(),
      "/co/acme/b": config(),
      "/co/acme/c": config(),
    };
    // The per-repo "state-issue write" — only a run that actually completes records.
    const wrote: Record<string, boolean> = {};
    const deps = {
      db,
      now: () => NOW,
      maxConcurrentRepos: 4,
      runTimeoutMs: 500, // B hangs 5s → times out; A (100) + C (200) finish first
      loadRepoConfig: (p: string) => configByPath[p] ?? null,
      runRecommender: async (r: ManagedRepo) => {
        if (r.repo === "acme/a") await Bun.sleep(100);
        else if (r.repo === "acme/c") await Bun.sleep(200);
        else await Bun.sleep(5000); // acme/b hangs past the timeout
        wrote[r.repo] = true;
      },
    };

    const start = performance.now();
    const fired = await runRecommenderCronPass(deps);
    const elapsed = performance.now() - start;

    // A + C succeeded; B did not.
    expect(fired).toBe(2);
    // The pass finished around the timeout (~500ms), NOT the 5s hang — B didn't
    // block A/C. Generous upper bound to stay non-flaky, but well under 5s.
    expect(elapsed).toBeLessThan(2000);

    // Observable isolation: A + C wrote their state; B's hung run never did.
    expect(wrote["acme/a"]).toBe(true);
    expect(wrote["acme/c"]).toBe(true);
    expect(wrote["acme/b"]).toBeUndefined();

    // The watermark: A + C keep their fresh stamp; B's is rolled back to "never
    // ran" (null) so the next tick retries it rather than going quiet an interval.
    expect(getLastRecommenderRun(db, "acme/a")).toBe(NOW);
    expect(getLastRecommenderRun(db, "acme/c")).toBe(NOW);
    expect(getLastRecommenderRun(db, "acme/b")).toBeNull();
  });

  test("a throwing run is isolated the same way (stamp rolled back, others succeed)", async () => {
    for (const r of ["good/a", "bad/b", "good/c"]) registerManagedRepo(db, r, `/co/${r}`);
    const configByPath: Record<string, MiddleConfig> = {
      "/co/good/a": config(),
      "/co/bad/b": config(),
      "/co/good/c": config(),
    };
    const deps = {
      db,
      now: () => NOW,
      maxConcurrentRepos: 4,
      runTimeoutMs: 1000,
      loadRepoConfig: (p: string) => configByPath[p] ?? null,
      runRecommender: async (r: ManagedRepo) => {
        if (r.repo === "bad/b") throw new Error("boom");
        await Bun.sleep(20);
      },
    };

    expect(await runRecommenderCronPass(deps)).toBe(2);
    expect(getLastRecommenderRun(db, "good/a")).toBe(NOW);
    expect(getLastRecommenderRun(db, "good/c")).toBe(NOW);
    expect(getLastRecommenderRun(db, "bad/b")).toBeNull(); // rolled back, retries next tick
  });

  test("concurrency is bounded by maxConcurrentRepos", async () => {
    for (const r of ["r/1", "r/2", "r/3", "r/4", "r/5"]) registerManagedRepo(db, r, `/co/${r}`);
    const configByPath: Record<string, MiddleConfig> = Object.fromEntries(
      ["r/1", "r/2", "r/3", "r/4", "r/5"].map((r) => [`/co/${r}`, config()]),
    );
    let inFlight = 0;
    let maxInFlight = 0;
    const deps = {
      db,
      now: () => NOW,
      maxConcurrentRepos: 2,
      runTimeoutMs: 1000,
      loadRepoConfig: (p: string) => configByPath[p] ?? null,
      runRecommender: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Bun.sleep(30);
        inFlight--;
      },
    };

    expect(await runRecommenderCronPass(deps)).toBe(5);
    // Never more than the cap in flight at once.
    expect(maxInFlight).toBeLessThanOrEqual(2);
    // And it genuinely parallelized (didn't silently run one-at-a-time).
    expect(maxInFlight).toBe(2);
  });

  test("the pass still works (and is sequential-equivalent) with a single due repo", async () => {
    registerManagedRepo(db, "solo/repo", "/co/solo");
    const deps = {
      db,
      now: () => NOW,
      runTimeoutMs: 1000,
      loadRepoConfig: () => config(),
      runRecommender: async () => {
        await Bun.sleep(10);
      },
    };
    expect(await runRecommenderCronPass(deps)).toBe(1);
    expect(getLastRecommenderRun(db, "solo/repo")).toBe(NOW);
  });
});
