import { Bunqueue } from "bunqueue/client";
import { type PollerDeps, reconcileMergedParks, runPoller } from "./poller.ts";

/**
 * Default cadence for the GitHub poller. Slower than the watchdog (30s) — a
 * human reply or a review verdict isn't latency-sensitive at the second scale,
 * and a gentler cadence is kinder to GitHub rate limits. The poller spends ~1
 * `gh` call per parked workflow per tick and has no backoff yet (see #122), so
 * 60s keeps a many-parked-workflow / multi-repo deployment well clear of the
 * 5000/hr ceiling and of secondary (burst) limits while still healing
 * MERGED-transition divergence within one tick (Epic #168). Override via
 * `startPoller`. Pinned by the dispatcher's CLAUDE.md cadence contract — keep
 * the value and the doc in sync there.
 */
export const POLLER_INTERVAL_MS = 60_000;

/**
 * Extra reconciliation work the daemon hangs off each poller tick (Epic #168).
 * `perTickSweep` runs after the resume poll + merged-parks reconciliation, once
 * per tick. `onMergedTransition` is invoked from `reconcileMergedParks` whenever
 * a parked Epic's PR is observed transitioning to MERGED — the daemon wires it
 * to an *immediate* `reconcileOpenPRs` sweep so divergence on the sibling Epic
 * PRs is healed at the moment of merge, not up to a tick later.
 */
export type ReconcilerHooks = {
  perTickSweep?: () => Promise<void>;
  onMergedTransition?: (repo: string) => Promise<void>;
};

/**
 * Stand up the GitHub poller as a bunqueue cron: every `intervalMs` (default
 * {@link POLLER_INTERVAL_MS}) it runs one {@link runPoller} pass over parked
 * workflows with an armed wait, firing the resume signal when the unblocking
 * event appears, then runs one {@link reconcileMergedParks} pass to finalize
 * parked workflows whose Epic PR has landed/closed, then an optional
 * `reconcilers.perTickSweep` for the open-PR divergence reconciler (Epic #168).
 *
 * Returns a stop function that tears the cron down. Each pass is resilient on
 * its own (per-workflow failures are isolated); this wrapper guards each so a
 * thrown pass never crashes the cron worker — and isolates them from each other
 * so a failed resume poll still lets reconciliation run, and vice versa.
 */
export async function startPoller(
  deps: PollerDeps,
  intervalMs: number = POLLER_INTERVAL_MS,
  reconcilers: ReconcilerHooks = {},
): Promise<() => Promise<void>> {
  const queue = new Bunqueue("middle-poller", {
    embedded: true,
    processor: async () => {
      try {
        await runPoller(deps);
      } catch (error) {
        console.error(`[poller] pass failed: ${(error as Error).message}`);
      }
      try {
        await reconcileMergedParks({ ...deps, onMergedTransition: reconcilers.onMergedTransition });
      } catch (error) {
        console.error(`[reconcile] pass failed: ${(error as Error).message}`);
      }
      if (reconcilers.perTickSweep) {
        try {
          await reconcilers.perTickSweep();
        } catch (error) {
          console.error(`[pr-divergence] tick sweep failed: ${(error as Error).message}`);
        }
      }
    },
  });
  await queue.every("poller-tick", intervalMs);
  return async () => {
    await queue.close(true);
  };
}
