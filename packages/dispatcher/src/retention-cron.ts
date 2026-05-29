import type { Database } from "bun:sqlite";
import { Bunqueue } from "bunqueue/client";
import { RETENTION_CRON_INTERVAL_MS, runRetentionPass } from "./retention.ts";

/**
 * Collaborators the retention cron needs, as an injectable seam so the cron
 * wrapper unit-tests without a real engine. The daemon wires the live `db`; the
 * pass logic ({@link runRetentionPass}) is tested directly against an in-memory db.
 */
export type RetentionCronDeps = { db: Database };

/**
 * Stand up the retention cron as a bunqueue cron (mirrors `startRecommenderCron`
 * / `startPoller` / `startWatchdog`): every `intervalMs` (default daily,
 * {@link RETENTION_CRON_INTERVAL_MS}) it runs one {@link runRetentionPass}. Returns
 * a stop function that tears the cron down. `runRetentionPass` records its own
 * outcome (success or failure) in `retention_runs`; this wrapper additionally
 * guards the pass so a thrown pass logs and never crashes the cron worker.
 */
export async function startRetentionCron(
  deps: RetentionCronDeps,
  intervalMs: number = RETENTION_CRON_INTERVAL_MS,
): Promise<() => Promise<void>> {
  const queue = new Bunqueue("middle-retention-cron", {
    embedded: true,
    processor: async () => {
      try {
        runRetentionPass(deps.db);
      } catch (error) {
        console.error(`[retention-cron] pass failed: ${(error as Error).message}`);
      }
    },
  });
  await queue.every("retention-cron-tick", intervalMs);
  return async () => {
    await queue.close(true);
  };
}
