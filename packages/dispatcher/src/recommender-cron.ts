import type { Database } from "bun:sqlite";
import type { MiddleConfig } from "@middle/core";
import { Bunqueue } from "bunqueue/client";
import {
  getLastRecommenderRun,
  isPaused,
  listManagedRepos,
  type ManagedRepo,
  markRecommenderRun,
  setLastRecommenderRun,
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
/** Default cap on how many repos' recommender runs fire concurrently per pass (#227). */
export const DEFAULT_MAX_CONCURRENT_REPOS = 4;
/** Default per-repo run timeout inside a cron pass — a hung run is abandoned after this (#227). */
export const DEFAULT_RUN_TIMEOUT_MS = 60_000;

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
  /**
   * Max repos whose runs fire concurrently in one pass (#227). The daemon resolves
   * this from the global config's `[recommender] max_concurrent_repos`. Bounds the
   * fan-out so a many-repo daemon doesn't blow rate limits / memory. Default
   * {@link DEFAULT_MAX_CONCURRENT_REPOS}; a non-positive value is clamped to 1.
   */
  maxConcurrentRepos?: number;
  /**
   * Hard timeout for a single repo's run (#227). A run exceeding this is abandoned
   * (its stamp rolled back, marked failed) without blocking the others — the whole
   * point of parallelizing: a hung `gh`/state-write on repo A no longer stalls
   * repo B. Default {@link DEFAULT_RUN_TIMEOUT_MS}.
   */
  runTimeoutMs?: number;
  now?: () => number;
};

/** A repo that passed the due-check, with the prior stamp to roll back to on failure. */
type DueRepo = { managed: ManagedRepo; prev: number | null };

/**
 * Run `task` with a hard timeout. Resolves to `"ok"` if it settles first, or
 * `"timeout"` if the deadline wins (the underlying promise is then abandoned — it
 * keeps running but no longer blocks the pass, which is the isolation #227 needs).
 * A task that rejects propagates its rejection (caught per-repo by the caller).
 */
async function withTimeout(task: Promise<void>, ms: number): Promise<"ok" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([task.then(() => "ok" as const), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run `tasks` concurrently, at most `limit` in flight at once (a hand-rolled
 * bounded pool — no `pLimit` dependency). Awaits all of them (a barrier); each
 * task is self-isolating (the caller's task never rejects), so one slow/failed
 * task can't starve or abort the rest.
 */
async function runBounded(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  const max = Math.max(1, limit);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      await tasks[i]!();
    }
  }
  await Promise.all(Array.from({ length: Math.min(max, tasks.length) }, () => worker()));
}

/**
 * One due-check pass over the managed-repo registry. For each repo that is
 * managed, recommender-`enabled`, and not paused, whose `last_recommender_run`
 * is older than its `interval_minutes`, **stamp `last_recommender_run` to now
 * BEFORE firing** (so an overlapping tick — or a slow run — can't double-dispatch
 * the same repo; the next tick's due-check sees the fresh stamp) and run the
 * recommender.
 *
 * **Per-repo runs fire concurrently** (#227), bounded by `maxConcurrentRepos`,
 * each under a `runTimeoutMs` hard timeout. A hang, timeout, or throw on one repo
 * is isolated — its stamp is rolled back (so it retries next tick) and the other
 * repos' runs complete unaffected. Returns the number of runs that succeeded.
 *
 * Gating is deliberate: `enabled` is the master switch for *periodic* running;
 * `auto_dispatch` is a separate, downstream gate (the recommender workflow only
 * fires the auto-dispatch trigger when it's on), so a repo can run the
 * recommender on a schedule for ranking-only without auto-dispatching.
 */
export async function runRecommenderCronPass(deps: RecommenderCronDeps): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const timeoutMs = deps.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const limit = deps.maxConcurrentRepos ?? DEFAULT_MAX_CONCURRENT_REPOS;

  // Phase 1 — due-check + stamp, SYNCHRONOUSLY before any run fires. Stamping all
  // due repos up front (no intervening await) preserves the double-dispatch guard:
  // an overlapping tick sees every fresh stamp before this pass yields the loop.
  const due: DueRepo[] = [];
  for (const managed of listManagedRepos(deps.db)) {
    if (isPaused(deps.db, managed.repo, now)) continue;
    const rec = deps.loadRepoConfig(managed.checkoutPath)?.recommender;
    if (!rec?.enabled) continue;
    const intervalMs = rec.intervalMinutes * 60_000;
    // Guard a missing/zero/negative interval → never auto-run (a 0 would fire
    // every tick). A real periodic cadence must be a positive number of minutes.
    if (!(intervalMs > 0)) continue;
    const prev = getLastRecommenderRun(deps.db, managed.repo);
    if (now - (prev ?? 0) < intervalMs) continue; // not due yet
    markRecommenderRun(deps.db, managed.repo, now);
    due.push({ managed, prev });
  }

  // Phase 2 — fire the due repos concurrently (bounded), each under a hard
  // timeout. A failed/timed-out run rolls its stamp back so it retries next tick
  // rather than going quiet for a full interval; the rollback + log is that
  // repo's failure record, and it never touches another repo's run.
  let fired = 0;
  await runBounded(
    due.map(({ managed, prev }) => async () => {
      try {
        const outcome = await withTimeout(deps.runRecommender(managed), timeoutMs);
        if (outcome === "timeout") {
          setLastRecommenderRun(deps.db, managed.repo, prev);
          console.error(
            `[recommender-cron] ${managed.repo} run timed out after ${timeoutMs}ms — abandoned (retries next tick)`,
          );
          return;
        }
        fired++;
      } catch (error) {
        setLastRecommenderRun(deps.db, managed.repo, prev);
        console.error(`[recommender-cron] ${managed.repo} run failed: ${(error as Error).message}`);
      }
    }),
    limit,
  );
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
