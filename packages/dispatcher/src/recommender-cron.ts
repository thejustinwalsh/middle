import type { Database } from "bun:sqlite";
import type { MiddleConfig } from "@middle/core";
import { Bunqueue } from "bunqueue/client";
import {
  getLastRecommenderRun,
  isPaused,
  listManagedRepos,
  type ManagedRepo,
  markRecommenderRun,
} from "./repo-config.ts";

/**
 * Tick cadence for the recommender cron — the **due-check** granularity, not the
 * run frequency. Each tick scans the managed-repo registry and fires only the
 * repos whose per-repo `[recommender] interval_minutes` has elapsed since their
 * last run, so a 1-minute tick with a 60-minute interval still runs hourly. Much
 * gentler than the watchdog (30s); a recommender pass is heavy (it spawns an
 * agent) and not latency-sensitive.
 */
export const RECOMMENDER_CRON_INTERVAL_MS = 60_000;

/**
 * Collaborators the recommender cron needs, as injectable seams so the pass
 * unit-tests with no engine, GitHub, or config files. The daemon wires `db`, a
 * `loadRepoConfig` that reads each checkout's `.middle/config.toml`, and a
 * `runRecommender` that launches a run on an ephemeral engine; tests stub them.
 */
export type RecommenderCronDeps = {
  db: Database;
  /** Load a managed repo's merged config from its checkout, or null if unreadable. */
  loadRepoConfig: (checkoutPath: string) => MiddleConfig | null;
  /**
   * Fire a recommender run for a due repo (best-effort). The daemon wires this to
   * the same path the `/trigger/recommender` route uses (dispatchRecommender with
   * the auto-dispatch trigger); tests stub it. A throw is isolated per repo.
   */
  runRecommender: (repo: ManagedRepo) => Promise<void>;
  now?: () => number;
};

/**
 * One due-check pass over the managed-repo registry. For each repo that is
 * managed, recommender-`enabled`, and not paused, whose `last_recommender_run`
 * is older than its `interval_minutes`, **stamp `last_recommender_run` to now
 * BEFORE firing** (so an overlapping tick — or a slow run — can't double-dispatch
 * the same repo; the next tick's due-check sees the fresh stamp) and run the
 * recommender. Per-repo failures are isolated and retried next tick. Returns the
 * number of runs fired (for logging/tests).
 *
 * Gating is deliberate: `enabled` is the master switch for *periodic* running;
 * `auto_dispatch` is a separate, downstream gate (the recommender workflow only
 * fires the auto-dispatch trigger when it's on), so a repo can run the
 * recommender on a schedule for ranking-only without auto-dispatching.
 */
export async function runRecommenderCronPass(deps: RecommenderCronDeps): Promise<number> {
  const now = (deps.now ?? Date.now)();
  let fired = 0;
  for (const managed of listManagedRepos(deps.db)) {
    if (isPaused(deps.db, managed.repo, now)) continue;
    const rec = deps.loadRepoConfig(managed.checkoutPath)?.recommender;
    if (!rec?.enabled) continue;
    const intervalMs = rec.intervalMinutes * 60_000;
    // Guard a missing/zero/negative interval → never auto-run (a 0 would fire
    // every tick). A real periodic cadence must be a positive number of minutes.
    if (!(intervalMs > 0)) continue;
    const last = getLastRecommenderRun(deps.db, managed.repo) ?? 0;
    if (now - last < intervalMs) continue; // not due yet
    markRecommenderRun(deps.db, managed.repo, now); // stamp before firing — no double-dispatch
    try {
      await deps.runRecommender(managed);
      fired++;
    } catch (error) {
      console.error(`[recommender-cron] ${managed.repo} run failed: ${(error as Error).message}`);
    }
  }
  return fired;
}

/**
 * Stand up the recommender cron as a bunqueue cron (mirrors `startPoller` /
 * `startWatchdog`): every `intervalMs` (default {@link RECOMMENDER_CRON_INTERVAL_MS})
 * it runs one {@link runRecommenderCronPass}. Returns a stop function that tears
 * the cron down. The pass isolates per-repo failures; this wrapper guards the
 * whole pass too so a thrown pass never crashes the cron worker.
 */
export async function startRecommenderCron(
  deps: RecommenderCronDeps,
  intervalMs: number = RECOMMENDER_CRON_INTERVAL_MS,
): Promise<() => Promise<void>> {
  const queue = new Bunqueue("middle-recommender-cron", {
    embedded: true,
    processor: async () => {
      try {
        await runRecommenderCronPass(deps);
      } catch (error) {
        console.error(`[recommender-cron] pass failed: ${(error as Error).message}`);
      }
    },
  });
  await queue.every("recommender-cron-tick", intervalMs);
  return async () => {
    await queue.close(true);
  };
}
