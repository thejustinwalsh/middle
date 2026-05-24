import { Bunqueue } from "bunqueue/client";
import { runPoller, type PollerDeps } from "./poller.ts";

/**
 * How often the poller checks GitHub for resume triggers. Slower than the
 * watchdog (30s) — a human reply or a review verdict is not latency-sensitive,
 * and a gentler cadence is kinder to GitHub rate limits.
 */
export const POLLER_INTERVAL_MS = 60_000;

/**
 * Stand up the GitHub poller as a bunqueue cron: every {@link POLLER_INTERVAL_MS}
 * it runs one {@link runPoller} pass over parked workflows with an armed wait,
 * firing the resume signal when the unblocking event appears. Returns a stop
 * function that tears the cron down. The pass is resilient on its own (per-
 * workflow failures are isolated); this wrapper guards the whole pass too so a
 * thrown pass never crashes the cron worker.
 */
export async function startPoller(deps: PollerDeps): Promise<() => Promise<void>> {
  const queue = new Bunqueue("middle-poller", {
    embedded: true,
    processor: async () => {
      try {
        await runPoller(deps);
      } catch (error) {
        console.error(`[poller] pass failed: ${(error as Error).message}`);
      }
    },
  });
  await queue.every("poller-tick", POLLER_INTERVAL_MS);
  return async () => {
    await queue.close(true);
  };
}
