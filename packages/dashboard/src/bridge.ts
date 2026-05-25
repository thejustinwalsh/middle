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

import type { Database } from "bun:sqlite";
import { addRateLimitObserver, type RateLimitStatus } from "@middle/dispatcher/src/rate-limits.ts";
import {
  addWorkflowObserver,
  getWorkflow,
} from "@middle/dispatcher/src/workflow-record.ts";
import type { DashboardEventBus } from "./events.ts";
import type { GlobalBanner } from "./wire.ts";

/** The SSE event type carrying a fresh banner on the global channel. */
export const BANNER_EVENT = "banner";

/** The SSE event type nudging a repo's channel that a workflow transitioned. */
export const WORKFLOW_EVENT = "workflow";

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

/**
 * Register a workflow observer that broadcasts a `workflow` nudge on the repo's
 * SSE channel whenever a workflow transitions, so the dashboard's expanded-repo
 * views refresh live instead of by polling. Returns a disposer (the daemon folds
 * it into shutdown). The repo is resolved from the row (the patch may not carry
 * it). Observers fan out, so this coexists with the daemon's control-feed
 * broadcaster. The payload is a minimal nudge — the repo channel's consumer
 * refetches on any `workflow` event and ignores the frame body.
 */
export function bridgeWorkflowsToBus(bus: DashboardEventBus, db: Database): () => void {
  return addWorkflowObserver((id) => {
    const row = getWorkflow(db, id);
    if (!row) return;
    bus.broadcastRepo(row.repo, {
      type: WORKFLOW_EVENT,
      data: { id, repo: row.repo, epic: row.epicNumber, state: row.state },
    });
  });
}
