import type { Database } from "bun:sqlite";
import { AGENT_COMMENT_MARKER, reasonFromSignalName } from "./poller.ts";
import { WAITFOR_TIMEOUT_MS } from "./workflows/implementation.ts";
import { hasEventOfType, loadPollableWaits, recordEvent } from "./workflow-record.ts";

/**
 * Staleness escalation for long-parked Epics (#253).
 *
 * The park's top-level `waitFor` is deliberately **timeout-free**: a bunqueue
 * waitFor timeout fires destructive saga compensation (`cleanupWorktree` destroys
 * the worktree), so the old 7-day timeout silently deleted long-parked work. This
 * pass is the **non-destructive** replacement for that ceiling: a `waiting-human`
 * row whose armed wait has gone unanswered past a configurable threshold (default
 * 7 days) gets one escalation comment on its Epic and a `park.escalated` event —
 * and the worktree is left **entirely untouched** (no compensate, no teardown).
 * A human who answers days later still finds the branch, `plan.md`, and
 * `decisions.md` intact.
 *
 * The threshold is clamped below the documented {@link WAITFOR_TIMEOUT_MS} ceiling
 * (90 days) so escalation always fires before a park is considered ceiling-stale.
 *
 * It is the parked-too-long twin of the poller's CI-pending escalation: same
 * arm-time threshold proxy, same `postEpicComment` seam, same best-effort
 * posture. It runs as one more guarded pass on the existing poller cron — no new
 * cron.
 */

/**
 * The `events` row type recorded when a stale park is escalated. Doubles as the
 * **idempotency key**: a row with this event has already been escalated and is
 * skipped on every later pass, so the Epic gets exactly one comment per park.
 */
export const PARK_ESCALATED_EVENT = "park.escalated";

/**
 * Default staleness threshold: a park armed longer than this with no fired signal
 * is escalated. 7 days matches the *old* destructive `waitFor` ceiling — the
 * point at which work used to silently vanish is now the point at which a human
 * is pinged instead. Configurable per deployment via {@link ParkEscalationDeps}.
 */
export const DEFAULT_PARK_STALENESS_MS = 7 * 24 * 3600 * 1000;

/** Most parks escalated in one pass — burst protection on the `gh` comment calls. */
export const DEFAULT_MAX_ESCALATIONS_PER_PASS = 10;

/**
 * Whether a park armed at `armedAt` is stale as of `now` for the given threshold.
 * Pure threshold comparison, exported so the boundary is unit-testable without a
 * DB. The comparison is strict (`>`): a park exactly at the threshold is not yet
 * stale, mirroring {@link isCiPendingEscalation}'s convention.
 */
export function isParkStale(armedAt: number, now: number, thresholdMs: number): boolean {
  return now - armedAt > thresholdMs;
}

/** Inputs for one {@link runParkEscalation} pass. */
export type ParkEscalationDeps = {
  db: Database;
  /**
   * Post the escalation comment on the Epic (best-effort). Omitted → the pass
   * logs to stderr and records **nothing** (no `park.escalated` event), so a
   * later run with the seam wired still escalates rather than finding a silent
   * marker that suppresses the never-posted comment. Wired by the daemon; tests stub it.
   */
  postEpicComment?: (repo: string, epicRef: string, body: string) => Promise<void>;
  /** Injectable clock (default `Date.now`). */
  now?: () => number;
  /** Staleness threshold (default {@link DEFAULT_PARK_STALENESS_MS}). */
  thresholdMs?: number;
  /** Cap on escalations per pass (default {@link DEFAULT_MAX_ESCALATIONS_PER_PASS}). */
  maxPerPass?: number;
};

/**
 * Human-readable label for what a stale park is waiting on, derived from its
 * durable signal name. Used in the escalation comment so the human reads *why*
 * it's parked, not just that it is.
 */
function waitingForLabel(signalName: string): string {
  switch (reasonFromSignalName(signalName)) {
    case "review-changes":
      return "a PR review verdict";
    case "answered-question":
      return "a human answer";
    default:
      return "a resume signal";
  }
}

/** The escalation comment body. Carries {@link AGENT_COMMENT_MARKER} (see below). */
function escalationComment(days: number, signalName: string): string {
  // The marker MUST lead: the dispatcher posts under a human (non-bot) gh
  // identity, so without it `classifyNewHumanReply` would read middle's own
  // escalation on an answered-question park as *the human's answer* and fire a
  // spurious resume. `startsWith(AGENT_COMMENT_MARKER)` is how the poller
  // self-discriminates — same convention as the CI-pending escalation.
  return (
    `${AGENT_COMMENT_MARKER}\n` +
    `⏳ **This Epic has been parked for ${days} day${days === 1 ? "" : "s"} waiting for ` +
    `${waitingForLabel(signalName)}; no action detected.**\n\n` +
    `The work is preserved — its branch, \`plan.md\`, and \`decisions.md\` are all intact ` +
    `and the dispatch resumes as soon as the awaited action arrives. This is a nudge, ` +
    `not a deadline: nothing is destroyed by the wait.`
  );
}

/**
 * One staleness-escalation pass over every armed, not-yet-fired `waiting-human`
 * wait. For each whose arm time exceeds the threshold and that has not already
 * been escalated, post one Epic comment and record one {@link PARK_ESCALATED_EVENT}
 * — **the worktree is never touched**. Idempotent (the event is the dedupe key),
 * capped per pass, and per-park failure-isolated so one bad write doesn't abort
 * the rest. Returns the number of parks escalated this pass.
 *
 * The event is recorded **only after a successful post**: an absent `postEpicComment`
 * or a failed comment leaves the park un-escalated so the next pass retries,
 * rather than burning the idempotency marker on an escalation that never reached
 * GitHub.
 */
export async function runParkEscalation(deps: ParkEscalationDeps): Promise<number> {
  const now = (deps.now ?? Date.now)();
  // Clamp below the documented ceiling: a threshold at/above WAITFOR_TIMEOUT_MS
  // would never let escalation fire before a park is "ceiling-stale", defeating
  // the whole non-destructive-surfacing purpose. `- 1` keeps the bound strict.
  const requested = deps.thresholdMs ?? DEFAULT_PARK_STALENESS_MS;
  const thresholdMs = Math.min(requested, WAITFOR_TIMEOUT_MS - 1);
  const maxPerPass = deps.maxPerPass ?? DEFAULT_MAX_ESCALATIONS_PER_PASS;

  const stale = loadPollableWaits(deps.db).filter(
    (w) =>
      w.firedAt === null &&
      w.epicRef !== null &&
      isParkStale(w.createdAt, now, thresholdMs) &&
      !hasEventOfType(deps.db, w.workflowId, PARK_ESCALATED_EVENT),
  );
  if (stale.length === 0) return 0;

  let escalated = 0;
  for (const wait of stale.slice(0, maxPerPass)) {
    const epicRef = wait.epicRef!; // narrowed by the filter above
    const days = Math.floor((now - wait.createdAt) / (24 * 60 * 60 * 1000));
    if (!deps.postEpicComment) {
      // No surface to escalate to — log and skip WITHOUT recording the event, so
      // the escalation isn't silently suppressed once a poster is wired.
      console.error(
        `[park-escalation] ${wait.repo}#${epicRef} parked ${days}d with no postEpicComment seam — skipping (will retry)`,
      );
      continue;
    }
    try {
      await deps.postEpicComment(wait.repo, epicRef, escalationComment(days, wait.signalName));
      recordEvent(deps.db, {
        workflowId: wait.workflowId,
        ts: now,
        type: PARK_ESCALATED_EVENT,
        payloadJson: JSON.stringify({ days, signalName: wait.signalName }),
      });
      escalated++;
      console.error(
        `[park-escalation] ${wait.repo}#${epicRef} parked ${days}d → escalated (worktree preserved)`,
      );
    } catch (error) {
      console.error(
        `[park-escalation] escalation failed for ${wait.repo}#${epicRef} (continuing): ${(error as Error).message}`,
      );
    }
  }
  return escalated;
}
