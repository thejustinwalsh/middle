/**
 * Bridges that push the dispatcher's live state into the dashboard's SSE bus.
 * The daemon (when it hosts the dashboard) calls these so a detection becomes a
 * pushed frame; kept here, separate from the routes, because they reach into the
 * dispatcher's process-global observers.
 *
 * The rate-limit bridge is the load-bearing "banner updates within 2s of
 * detection" path: a usage-limit detection flips `rate_limit_state` and fires
 * the observer, which recomputes the banner and broadcasts it on the global
 * channel — no polling latency.
 */

import { addRateLimitObserver, type RateLimitStatus } from "@middle/dispatcher/src/rate-limits.ts";
import type { DashboardEventBus } from "./events.ts";
import type { GlobalBanner } from "./wire.ts";

/** The SSE event type carrying a fresh banner on the global channel. */
export const BANNER_EVENT = "banner";

/**
 * Register a rate-limit observer that broadcasts a fresh banner on the global
 * channel whenever an adapter's rate-limit state changes. Returns a disposer
 * that removes only THIS banner observer (the daemon calls it on dispose),
 * leaving the daemon's auto-dispatch observer intact. Observers fan out, so
 * this coexists with the daemon's own registration.
 */
export function bridgeRateLimitsToBus(
  bus: DashboardEventBus,
  computeBanner: () => Promise<GlobalBanner>,
): () => void {
  const observer = (_adapter: string, _status: RateLimitStatus): void => {
    void computeBanner()
      .then((banner) => bus.broadcastGlobal({ type: BANNER_EVENT, data: banner }))
      .catch(() => {
        // A failed banner recompute must never break the rate-limit write path.
      });
  };
  return addRateLimitObserver(observer);
}
