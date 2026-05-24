import type { Database } from "bun:sqlite";
import type { ResumeReason } from "./workflows/implementation.ts";
import { loadPollableWaits, markSignalFired } from "./workflow-record.ts";

/**
 * The GitHub poller fires a parked workflow's resume signal when its unblocking
 * event appears on GitHub — for both pause kinds, which share the
 * park → external-signal → resume spine:
 *
 *  - `answered-question` — a new human (non-bot) reply on the Epic resumes it.
 *  - `review-changes` — a PR review verdict. `CHANGES_REQUESTED` (a review or
 *    the `changes-requested` label) resumes the agent to address feedback;
 *    **resolved** — `APPROVED`, or a fresh re-review reporting **0 actionable
 *    comments** — ends the loop. The 0-actionable case matters because a bot
 *    reviewer (CodeRabbit) often won't flip `CHANGES_REQUESTED → APPROVED` on
 *    its own, so a clean re-review must count as resolved or the loop hangs on
 *    an approval that never comes.
 *
 * The poller only *detects and fires*; the resume step (sub-issue #36)
 * interprets the payload (re-prime with the answer / review threads, the round
 * cap, terminating on resolved). Firing is idempotent: a fired wait is marked
 * (`fired_at`) and skipped until the workflow resumes and a fresh park rearms.
 *
 * Source of truth: build spec → "Build sequence" → "Phase 5".
 */

/** One issue comment, normalized for bot detection + recency. */
export type IssueComment = {
  id: number;
  authorLogin: string;
  authorIsBot: boolean;
  createdAt: number; // unix ms
  body: string;
};

/** One PR review, normalized. `state` is GitHub's review state verb. */
export type PrReview = {
  id: number;
  state: string; // 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | ...
  authorLogin: string;
  submittedAt: number; // unix ms
  body: string;
};

/** A PR's review-relevant snapshot. */
export type PrSnapshot = {
  number: number;
  reviewDecision: string | null; // 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  reviews: PrReview[];
  labels: string[];
};

/** The read-only GitHub surface the poller needs — injectable so tests need no `gh`. */
export type GitHubPollGateway = {
  listIssueComments(repo: string, issueNumber: number): Promise<IssueComment[]>;
  /** The Epic's one open PR, or null if it hasn't been opened yet. */
  findPrForEpic(repo: string, epicNumber: number): Promise<PrSnapshot | null>;
};

/** What the poller fires into the workflow's resume signal for #36 to interpret. */
export type ResumeSignalPayload =
  | {
      reason: "answered-question";
      reply: { commentId: number; authorLogin: string; body: string };
    }
  | {
      reason: "review-changes";
      outcome: ReviewOutcome;
      reviewId: number | null;
      decision: string | null;
    };

export type ReviewOutcome = "changes-requested" | "resolved";

export type PollerDeps = {
  db: Database;
  github: GitHubPollGateway;
  /** Deliver the resume signal to the parked workflow (engine.signal in prod). */
  fireSignal: (workflowId: string, payload: ResumeSignalPayload) => Promise<void>;
  now?: () => number;
};

const ACTIONABLE_RE = /actionable comments posted:\s*(\d+)/i;

/** The resume reason a durable signal name encodes, or null if not poller-driven. */
export function reasonFromSignalName(name: string): ResumeReason | null {
  if (name.endsWith("-review-resolved")) return "review-changes";
  // `epic-<n>-answered` (workflow) and `blocked:<id>` (watchdog re-arm fallback)
  // are both the question-sentinel pause.
  if (name.endsWith("-answered") || name.startsWith("blocked:")) return "answered-question";
  return null;
}

/** The newest non-bot reply posted after the wait armed, or null. */
export function classifyNewHumanReply(comments: IssueComment[], sinceMs: number): IssueComment | null {
  const fresh = comments
    .filter((c) => !c.authorIsBot && c.createdAt > sinceMs)
    .sort((a, b) => b.createdAt - a.createdAt);
  return fresh[0] ?? null;
}

/**
 * Classify the PR's review state into a resume verdict, or null when nothing
 * actionable has changed since the wait armed. The newest review submitted this
 * round is authoritative; a 0-actionable re-review counts as **resolved** even
 * while the PR's `reviewDecision` still reads `CHANGES_REQUESTED`. Falls back to
 * the standing decision / `changes-requested` label when no fresh review exists.
 */
export function classifyReviewOutcome(
  snapshot: PrSnapshot,
  sinceMs: number,
): { outcome: ReviewOutcome; reviewId: number | null; decision: string | null } | null {
  const fresh = snapshot.reviews
    .filter((r) => r.submittedAt > sinceMs)
    .sort((a, b) => b.submittedAt - a.submittedAt);
  const latest = fresh[0];
  if (latest) {
    if (latest.state === "APPROVED") {
      return { outcome: "resolved", reviewId: latest.id, decision: "APPROVED" };
    }
    const m = ACTIONABLE_RE.exec(latest.body);
    if (m && Number(m[1]) === 0) {
      // Clean re-review — resolved even if the decision hasn't flipped.
      return { outcome: "resolved", reviewId: latest.id, decision: snapshot.reviewDecision };
    }
    if (latest.state === "CHANGES_REQUESTED" || (m && Number(m[1]) > 0)) {
      return { outcome: "changes-requested", reviewId: latest.id, decision: "CHANGES_REQUESTED" };
    }
  }
  // No fresh verdict from a review this round — fall back to standing state.
  if (snapshot.reviewDecision === "APPROVED") {
    return { outcome: "resolved", reviewId: null, decision: "APPROVED" };
  }
  if (snapshot.reviewDecision === "CHANGES_REQUESTED" || snapshot.labels.includes("changes-requested")) {
    return { outcome: "changes-requested", reviewId: null, decision: "CHANGES_REQUESTED" };
  }
  return null;
}

/**
 * One poll pass over every parked workflow with an armed, not-yet-fired wait.
 * Fires the resume signal when the unblocking event appears, then marks the
 * wait fired (idempotent). Per-workflow failures (GitHub rate limits, transient
 * errors) are isolated and logged — they skip that workflow this pass and are
 * retried next pass; they never abort the pass for the others. Returns the
 * number of signals fired (for logging/tests).
 */
export async function runPoller(deps: PollerDeps): Promise<number> {
  const now = (deps.now ?? Date.now)();
  let fired = 0;
  for (const wait of loadPollableWaits(deps.db)) {
    if (wait.firedAt !== null || wait.epicNumber === null) continue;
    const reason = reasonFromSignalName(wait.signalName);
    if (!reason) continue;
    try {
      if (reason === "answered-question") {
        const comments = await deps.github.listIssueComments(wait.repo, wait.epicNumber);
        const reply = classifyNewHumanReply(comments, wait.createdAt);
        if (!reply) continue;
        await deps.fireSignal(wait.workflowId, {
          reason,
          reply: { commentId: reply.id, authorLogin: reply.authorLogin, body: reply.body },
        });
      } else {
        const pr = await deps.github.findPrForEpic(wait.repo, wait.epicNumber);
        if (!pr) continue;
        const verdict = classifyReviewOutcome(pr, wait.createdAt);
        if (!verdict) continue;
        await deps.fireSignal(wait.workflowId, {
          reason,
          outcome: verdict.outcome,
          reviewId: verdict.reviewId,
          decision: verdict.decision,
        });
      }
      markSignalFired(deps.db, wait.workflowId, now);
      fired++;
    } catch (error) {
      console.error(
        `[poller] poll failed for workflow ${wait.workflowId} (${wait.signalName}): ${(error as Error).message}`,
      );
    }
  }
  return fired;
}
