import { Bunqueue } from "bunqueue/client";
import { reconcileTranscriptDrift, runWatchdog, type WatchdogDeps } from "./watchdog.ts";

/** How often the watchdog reconciles. The spec mandates 30s. */
export const WATCHDOG_INTERVAL_MS = 30_000;

/**
 * Stand up the watchdog as a bunqueue cron: every {@link WATCHDOG_INTERVAL_MS}
 * the worker runs the transcript-drift reconciler (correct heartbeats from the
 * source-of-truth transcript) and then a watchdog pass (launch-timeout, tmux
 * liveness, idle detection, sentinel re-arm). Drift runs first so freshness sees
 * corrected heartbeats. Returns a stop function that tears the cron down.
 *
 * The reconcile logic itself (`runWatchdog` / `reconcileTranscriptDrift`) is
 * pure and unit-tested; this wrapper is the thin scheduling glue.
 */
export async function startWatchdog(deps: WatchdogDeps): Promise<() => Promise<void>> {
  const queue = new Bunqueue("middle-watchdog", {
    embedded: true,
    processor: async () => {
      try {
        reconcileTranscriptDrift(deps);
        await runWatchdog(deps);
      } catch (error) {
        console.error(`[watchdog] reconcile pass failed: ${(error as Error).message}`);
      }
    },
  });
  await queue.every("watchdog-tick", WATCHDOG_INTERVAL_MS);
  return async () => {
    await queue.close(true);
  };
}
