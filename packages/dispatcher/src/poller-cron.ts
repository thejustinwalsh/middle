import { Bunqueue } from "bunqueue/client";
import {
  type CheckboxRevertPassDeps,
  runCheckboxRevertPass,
} from "./gates/checkbox-revert-pass.ts";
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

/** Optional extra passes the poller cron runs alongside the resume/reconcile core. */
export type StartPollerOptions = {
  /**
   * The checkbox-revert production trigger (#101). When provided, each tick also
   * runs {@link runCheckboxRevertPass} over running workflows. Omitted (e.g. tests)
   * → the pass doesn't run.
   */
  checkboxRevert?: CheckboxRevertPassDeps;
  /** Tick cadence override (default {@link POLLER_INTERVAL_MS}). */
  intervalMs?: number;
  /**
   * The Phase-2 file-mode answer watcher (#197). When wired, each tick also runs
   * one mtime-poll pass over file-mode repos' `epics_dir`, firing the resume
   * signal for any parked Epic whose `<!-- middle:answer -->` block became
   * non-empty. Hung off the existing cron (no new cron, same 120s cadence).
   * Omitted → file-mode answers resume only via the manual `mm resume` escape hatch.
   */
  fileWatcher?: () => Promise<void>;
  /**
   * Open-PR divergence reconciler hooks (Epic #168). When provided, each tick
   * runs `perTickSweep` after the resume + merged-parks reconciliation, and
   * `onMergedTransition` is wired into `reconcileMergedParks` so a freshly-merged
   * Epic PR triggers an immediate sibling-sweep. Omitted → no reconciliation.
   */
  reconcilers?: ReconcilerHooks;
};

/**
 * Stand up the GitHub poller as a bunqueue cron: every `intervalMs` (default
 * {@link POLLER_INTERVAL_MS}) it runs one {@link runPoller} pass over parked
 * workflows with an armed wait, firing the resume signal when the unblocking
 * event appears, then one {@link reconcileMergedParks} pass to finalize parked
 * workflows whose Epic PR has landed/closed, optionally one
 * `opts.reconcilers.perTickSweep` for the open-PR divergence reconciler (Epic
 * #168), and — when `opts.checkboxRevert` is wired — one
 * {@link runCheckboxRevertPass} over running workflows to revert a Status
 * checkbox whose verification gates failed after a push. Returns a stop function
 * that tears the cron down. Each pass is resilient on its own (per-workflow
 * failures are isolated); this wrapper guards each so a thrown pass never
 * crashes the cron worker — and isolates them from one another so one failed
 * pass still lets the others run.
 */
export async function startPoller(
  deps: PollerDeps,
  opts: StartPollerOptions = {},
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
        await reconcileMergedParks({
          ...deps,
          onMergedTransition: opts.reconcilers?.onMergedTransition,
        });
      } catch (error) {
        console.error(`[reconcile] pass failed: ${(error as Error).message}`);
      }
      if (opts.reconcilers?.perTickSweep) {
        try {
          await opts.reconcilers.perTickSweep();
        } catch (error) {
          console.error(`[pr-divergence] tick sweep failed: ${(error as Error).message}`);
        }
      }
      if (opts.checkboxRevert) {
        try {
          await runCheckboxRevertPass(opts.checkboxRevert);
        } catch (error) {
          console.error(`[checkbox-revert] pass failed: ${(error as Error).message}`);
        }
      }
      if (opts.fileWatcher) {
        try {
          await opts.fileWatcher();
        } catch (error) {
          console.error(`[file-watcher] pass failed: ${(error as Error).message}`);
        }
      }
    },
  });
  await queue.every("poller-tick", opts.intervalMs ?? POLLER_INTERVAL_MS);
  return async () => {
    await queue.close(true);
  };
}
