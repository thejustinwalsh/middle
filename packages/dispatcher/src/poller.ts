import type { Database } from "bun:sqlite";
import type { ResumeReason } from "./workflows/implementation.ts";
import {
  finalizeParkedWorkflow,
  listParkedImplementationWorkflows,
  loadPollableWaits,
  markSignalFired,
} from "./workflow-record.ts";

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

/**
 * A PR's CI standing, collapsed from `statusCheckRollup`:
 * - `passing` — every required check succeeded (or was neutral/skipped).
 * - `failing` — at least one check failed/errored/was cancelled.
 * - `pending` — nothing failed yet, but a check is still running/queued.
 * - `none` — no checks are configured on the PR (nothing to gate on).
 */
export type CiStatus = "passing" | "failing" | "pending" | "none";

/** A PR's review-relevant snapshot. */
export type PrSnapshot = {
  number: number;
  reviewDecision: string | null; // 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  reviews: PrReview[];
  labels: string[];
  /** CI rollup. Absent (legacy/test fixtures) is treated as `none` — non-blocking. */
  ci?: CiStatus;
};

/** The synthetic `decision` a CI-failure resume carries, distinct from a review `CHANGES_REQUESTED`. */
export const CI_FAILED_DECISION = "CI_FAILED";

/** GitHub's remaining REST budget and when it resets (epoch ms). */
export type RateLimitStatus = { remaining: number; resetAt: number };

/**
 * The lifecycle standing of an Epic's PR across ALL states — `MERGED` and
 * `CLOSED` (unmerged) included, unlike {@link PrSnapshot} which is open-only.
 * Drives park reconciliation: a parked workflow whose PR has landed or been
 * abandoned must leave `waiting-human`.
 */
export type EpicPrLifecycle = { number: number; state: "OPEN" | "MERGED" | "CLOSED" };

/** The read-only GitHub surface the poller needs — injectable so tests need no `gh`. */
export type PollGateway = {
  listIssueComments(repo: string, ref: string): Promise<IssueComment[]>;
  /** The Epic's one open PR, or null if it hasn't been opened yet. */
  findPrForEpic(repo: string, epicRef: string): Promise<PrSnapshot | null>;
  /**
   * The Epic's PR lifecycle across every state (open/merged/closed), or null if
   * no PR references the Epic. Unlike {@link findPrForEpic} (open-only), this
   * sees a merged/closed PR so a parked workflow can be reconciled to terminal.
   */
  findEpicPrLifecycle(repo: string, epicRef: string): Promise<EpicPrLifecycle | null>;
  /**
   * Review snapshot for a **known** PR number — the resolve-then-fetch half of
   * {@link findPrForEpic} factored out. The github finder resolves the Epic's PR
   * by its `Closes #<n>` linkage and then calls this; a file-mode Epic (a slug
   * with no `Closes #` linkage) instead resolves its PR from the Epic file's
   * durable `meta.pr` stamp and calls this directly. `null` when no such open PR
   * exists. The PR itself is GitHub-native in both Epic-store modes.
   */
  prSnapshot(repo: string, prNumber: number): Promise<PrSnapshot | null>;
  /**
   * Lifecycle (open/merged/closed) for a **known** PR number — the file-mode
   * counterpart to {@link findEpicPrLifecycle}, which resolves a single PR from
   * the Epic file's `meta.pr` rather than searching `Closes #<n>` across history.
   * `null` when the PR number doesn't resolve.
   */
  prLifecycle(repo: string, prNumber: number): Promise<EpicPrLifecycle | null>;
  /**
   * Current REST budget. Read from `gh api rate_limit`, whose own request does
   * not consume quota — so the poller can consult it every pass for free.
   */
  getRateLimit(): Promise<RateLimitStatus>;
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
  github: PollGateway;
  /** Deliver the resume signal to the parked workflow (engine.signal in prod). */
  fireSignal: (workflowId: string, payload: ResumeSignalPayload) => Promise<void>;
  now?: () => number;
  /**
   * Skip the whole pass when GitHub's remaining REST budget is below this.
   * Defaults to {@link DEFAULT_RATE_LIMIT_BUFFER}.
   */
  rateLimitBuffer?: number;
  /**
   * Cap on the workflows polled in one pass — burst protection against tripping
   * secondary limits. Defaults to {@link DEFAULT_MAX_POLLS_PER_PASS}.
   */
  maxPollsPerPass?: number;
  /**
   * Tear down a reconciled workflow's worktree (best-effort). Receives the repo
   * slug + the row's `worktreePath`. Optional: omitted → the row is still
   * finalized, just without disk cleanup. Wired by the daemon; tests stub it.
   */
  removeWorktree?: (repo: string, worktreePath: string | null) => Promise<void>;
};

/**
 * Skip a pass when GitHub's remaining REST budget is below this. Leaves headroom
 * for the agent's own `gh` use + interactive work, and keeps the poller from
 * being the thing that tips the account over its hourly limit.
 */
export const DEFAULT_RATE_LIMIT_BUFFER = 100;

/**
 * Most workflows polled in a single pass. Bounds the burst of `gh` calls a large
 * parked set would otherwise fire in a tight loop (the secondary/abuse-limit
 * risk); the remainder are picked up on the next tick.
 */
export const DEFAULT_MAX_POLLS_PER_PASS = 25;

/**
 * Slack window applied to the fresh-review filter in {@link classifyReviewVerdict}.
 *
 * CodeRabbit (and other fast bots) can post a review within seconds of a push.
 * The drive pipeline — verify gates, nudges, `parkForResume` — takes 30–120 s
 * to arm the wait. Reviews that land in that window would otherwise be filtered
 * as "stale" (submitted before `sinceMs`) and the PR would sit in
 * `waiting-human` forever. Adding a 5-minute lookback catches those fast
 * reviews without meaningfully widening the staleness window for genuine old
 * reviews (which are many minutes older).
 *
 * **Residual risk:** if the agent addresses a review and re-parks within this
 * 5-minute slack window, the prior review is still inside the window; the
 * poller would treat it as fresh and re-fire. A fuller fix would compare
 * against the last-push timestamp rather than the arm timestamp — deferred
 * until the push timestamp is reliably available in the parked row.
 */
export const REVIEW_WINDOW_SLACK_MS = 5 * 60 * 1000;

const ACTIONABLE_RE = /actionable comments posted:\s*(\d+)/i;

/** The resume reason a durable signal name encodes, or null if not poller-driven. */
export function reasonFromSignalName(name: string): ResumeReason | null {
  if (name.endsWith("-review-resolved")) return "review-changes";
  // `epic-<n>-answered` (workflow) and `blocked:<id>` (watchdog re-arm fallback)
  // are both the question-sentinel pause.
  if (name.endsWith("-answered") || name.startsWith("blocked:")) return "answered-question";
  return null;
}

/**
 * Hidden HTML-comment marker the dispatcher prepends to every pause comment it
 * posts on the Epic (see `formatPauseComment`). The dispatcher posts under its
 * own `gh` identity — a *human* (non-bot) account — so the poller can't tell an
 * agent-posted question from a genuine human reply by author alone:
 * {@link classifyNewHumanReply} would treat the agent's own question as "the
 * human answer" and fire a spurious resume. The marker is the structural
 * self-discrimination — a comment that *starts with* it is middle's own and
 * never counts as a human reply. Mirrors the state issue's `OPEN_MARKER` and the
 * gate-evidence marker conventions; keeps the gh-identity model (no bot account).
 */
export const AGENT_COMMENT_MARKER = "<!-- middle:agent-comment -->";

/**
 * The newest non-bot reply posted after the wait armed, or null.
 *
 * Skips the dispatcher's own pause comments by the {@link AGENT_COMMENT_MARKER}
 * prefix. The match is `startsWith`, not `includes`, deliberately: the dispatcher
 * always emits the marker at byte 0, so `startsWith` identifies exactly its own
 * comments, whereas `includes` would also drop a genuine human reply that
 * quote-replies the pause comment (GitHub copies the marker into the quote),
 * silently dropping the real answer and hanging the resume.
 */
export function classifyNewHumanReply(
  comments: IssueComment[],
  sinceMs: number,
): IssueComment | null {
  const fresh = comments
    .filter(
      (c) => !c.authorIsBot && c.createdAt > sinceMs && !c.body.startsWith(AGENT_COMMENT_MARKER),
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  return fresh[0] ?? null;
}

/** The resume verdict a classification resolves to (or null = nothing actionable). */
type ReviewVerdict = { outcome: ReviewOutcome; reviewId: number | null; decision: string | null };

/**
 * Classify the PR into a resume verdict, **CI-gated**: a PR isn't reviewable
 * until it builds, so CI standing participates in the verdict alongside reviews.
 *
 * Precedence:
 *  1. **Explicit review feedback wins** — a `CHANGES_REQUESTED` (review or label)
 *     resumes for the feedback; addressing it should also green CI, so don't
 *     pre-empt it with a CI nudge.
 *  2. **Red CI is its own resume trigger** — failing checks with no outstanding
 *     review feedback resume the agent to fix CI ({@link CI_FAILED_DECISION}).
 *  3. **A resolve is gated on green** — an `APPROVED`/0-actionable verdict while
 *     checks are still `pending` is held (null) until they finish, so the loop
 *     never ends on a PR whose CI hasn't reported. `passing`/`none` resolves.
 *
 * Absent CI (`undefined` → `none`) is non-blocking, so the pre-CI review loop is
 * unchanged.
 */
export function classifyReviewOutcome(
  snapshot: PrSnapshot,
  sinceMs: number,
  reviewSlackMs = REVIEW_WINDOW_SLACK_MS,
): ReviewVerdict | null {
  const review = classifyReviewVerdict(snapshot, sinceMs, reviewSlackMs);
  const ci = snapshot.ci ?? "none";
  if (review?.outcome === "changes-requested") return review;
  if (ci === "failing") {
    return { outcome: "changes-requested", reviewId: null, decision: CI_FAILED_DECISION };
  }
  if (review?.outcome === "resolved") return ci === "pending" ? null : review;
  return review;
}

/**
 * The review-only verdict (no CI gating) — the newest review submitted this
 * round is authoritative; a 0-actionable re-review counts as **resolved** even
 * while the PR's `reviewDecision` still reads `CHANGES_REQUESTED`. Falls back to
 * the standing decision / `changes-requested` label when no fresh review exists.
 */
function classifyReviewVerdict(
  snapshot: PrSnapshot,
  sinceMs: number,
  reviewSlackMs = REVIEW_WINDOW_SLACK_MS,
): ReviewVerdict | null {
  const fresh = snapshot.reviews
    .filter((r) => r.submittedAt > sinceMs - reviewSlackMs)
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
    if (latest.state === "DISMISSED") {
      // A reviewer dismissed their own review. Re-evaluate the PR's overall
      // decision: if it is no longer CHANGES_REQUESTED, the dismiss cleared the
      // last blocker and the PR is effectively approved — emit \`resolved\`.
      // If CHANGES_REQUESTED remains, other blocking reviews are still standing;
      // return null so the epic stays parked, but log explicitly so the dismiss
      // is visible in daemon logs and not silently swallowed.
      if (snapshot.reviewDecision !== "CHANGES_REQUESTED") {
        return { outcome: "resolved", reviewId: latest.id, decision: snapshot.reviewDecision };
      }
      console.error(
        `[poller] review ${latest.id} by ${latest.authorLogin} DISMISSED but PR decision ` +
          `is still CHANGES_REQUESTED — other blocking reviews remain; staying parked`,
      );
      return null;
    }
  }
  // No fresh verdict from a review this round — fall back to standing state.
  if (snapshot.reviewDecision === "APPROVED") {
    return { outcome: "resolved", reviewId: null, decision: "APPROVED" };
  }
  // Deliberately NOT a `reviewDecision === "CHANGES_REQUESTED"` fallback: a bot
  // reviewer leaves the PR's standing decision at CHANGES_REQUESTED even after a
  // clean re-review, so re-firing off it would re-dispatch the agent every pass
  // with no new feedback (and burn a round). A fresh review (handled above) or an
  // explicit human `changes-requested` label is the only trustworthy resume signal.
  if (snapshot.labels.includes("changes-requested")) {
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
 *
 * Two GitHub-friendliness guards run before any per-workflow `gh` call:
 *  - **Rate-limit ceiling** — if the remaining REST budget is below
 *    `rateLimitBuffer`, the whole pass is skipped (the work waits for the next
 *    tick, by which point the budget may have reset). Checking `rate_limit` is
 *    itself free, so this never costs budget.
 *  - **Burst cap** — at most `maxPollsPerPass` workflows are polled per pass, so
 *    a large parked set can't fire a tight burst that trips secondary limits.
 */
export async function runPoller(deps: PollerDeps): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const buffer = deps.rateLimitBuffer ?? DEFAULT_RATE_LIMIT_BUFFER;
  const maxPerPass = deps.maxPollsPerPass ?? DEFAULT_MAX_POLLS_PER_PASS;

  // Gather only the waits that will actually make GitHub calls, so the budget
  // gate + burst cap apply to the real workload (the skipped ones below cost
  // nothing).
  type PollableWait = ReturnType<typeof loadPollableWaits>[number];
  const actionable: Array<{ wait: PollableWait; reason: ResumeReason; epicRef: string }> = [];
  for (const wait of loadPollableWaits(deps.db)) {
    if (wait.firedAt !== null || wait.epicRef === null) continue;
    const reason = reasonFromSignalName(wait.signalName);
    if (reason === null) continue;
    // epicRef is narrowed to `string` past the guard above; capture it so the
    // gh calls in the loop below don't see the row's nullable type again.
    actionable.push({ wait, reason, epicRef: wait.epicRef });
  }
  if (actionable.length === 0) return 0;

  // Rate-limit ceiling: never let the poller be the call that tips us over.
  const budget = await deps.github.getRateLimit();
  if (budget.remaining < buffer) {
    console.error(
      `[poller] GitHub budget low (${budget.remaining} < ${buffer}); skipping pass — resets ${new Date(budget.resetAt).toISOString()}`,
    );
    return 0;
  }

  let fired = 0;
  // Burst cap: bound the calls fired in one tick; the rest wait for next pass.
  for (const { wait, reason, epicRef } of actionable.slice(0, maxPerPass)) {
    try {
      if (reason === "answered-question") {
        const comments = await deps.github.listIssueComments(wait.repo, epicRef);
        const reply = classifyNewHumanReply(comments, wait.createdAt);
        if (!reply) continue;
        await deps.fireSignal(wait.workflowId, {
          reason,
          reply: { commentId: reply.id, authorLogin: reply.authorLogin, body: reply.body },
        });
      } else {
        const pr = await deps.github.findPrForEpic(wait.repo, epicRef);
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

/**
 * Reconcile parked workflows whose Epic PR has **landed or been abandoned** —
 * the gap the resume poller doesn't cover. `runPoller` only watches *armed*
 * review/question waits and only acts on review *verdicts*; a human who simply
 * merges (or closes) the PR, or a cap-exhausted park that armed no signal at
 * all, leaves the row stuck in `waiting-human` forever, polluting the
 * observability view with ghosts of finished work.
 *
 * This pass walks every parked `implementation` workflow and consults the Epic
 * PR's lifecycle: **merged → `completed`**, **closed-unmerged → `cancelled`**,
 * **open (or no PR yet) → left alone** (a live review park / a pending
 * question). The state write broadcasts on the control feed, so the page drops
 * the row live. Worktree teardown is best-effort (`removeWorktree`); a failure
 * there never blocks the row's finalization.
 *
 * Shares `runPoller`'s GitHub-friendliness guards: the (free) rate-limit ceiling
 * and the per-pass burst cap. Per-workflow failures are isolated and retried
 * next pass. Returns the number of rows reconciled.
 */
export type ReconcileDeps = {
  db: Database;
  /** Only the two PR-lifecycle/budget reads the reconciler makes. */
  github: Pick<PollGateway, "findEpicPrLifecycle" | "getRateLimit">;
  /** Best-effort worktree teardown for a finalized row; omitted → skip cleanup. */
  removeWorktree?: (repo: string, worktreePath: string | null) => Promise<void>;
  /** Skip the pass when GitHub's budget is below this. Defaults to {@link DEFAULT_RATE_LIMIT_BUFFER}. */
  rateLimitBuffer?: number;
  /** Cap on rows reconciled per pass. Defaults to {@link DEFAULT_MAX_POLLS_PER_PASS}. */
  maxPollsPerPass?: number;
  /**
   * Fired *at most once per repo per pass* when a parked workflow's PR is
   * observed transitioning to MERGED. The daemon wires this to an immediate
   * `reconcileOpenPRs` sweep (Epic #168) so divergence on sibling Epic PRs is
   * healed at the moment of merge rather than up to a tick later. Per-pass
   * de-duplication is enforced inside `reconcileMergedParks` (not the
   * caller) — a timer- or microtask-based dedup at the call site would race
   * against the `await` boundaries inside the iteration loop.
   */
  onMergedTransition?: (repo: string) => Promise<void>;
};

export async function reconcileMergedParks(deps: ReconcileDeps): Promise<number> {
  const buffer = deps.rateLimitBuffer ?? DEFAULT_RATE_LIMIT_BUFFER;
  const maxPerPass = deps.maxPollsPerPass ?? DEFAULT_MAX_POLLS_PER_PASS;

  const parked = listParkedImplementationWorkflows(deps.db);
  if (parked.length === 0) return 0;

  const budget = await deps.github.getRateLimit();
  if (budget.remaining < buffer) {
    console.error(
      `[reconcile] GitHub budget low (${budget.remaining} < ${buffer}); skipping pass — resets ${new Date(budget.resetAt).toISOString()}`,
    );
    return 0;
  }

  let reconciled = 0;
  // Per-pass dedup for the `onMergedTransition` hook. Done here (not at the
  // call site) because a timer- or microtask-based dedup in the caller would
  // race against the `await deps.removeWorktree` / `await deps.onMergedTransition`
  // boundaries below — a `setTimeout(0)` reset can fire between iterations and
  // let a second sweep through for the same repo.
  const mergedRepos = new Set<string>();
  for (const wf of parked.slice(0, maxPerPass)) {
    try {
      const life = await deps.github.findEpicPrLifecycle(wf.repo, wf.epicRef);
      // Open PR (a live review park) or no PR yet (a pending question) → leave it
      // for `runPoller` / the human; only a landed/abandoned PR is reconciled.
      if (!life || life.state === "OPEN") continue;
      const finalState = life.state === "MERGED" ? "completed" : "cancelled";
      // Transition FIRST, conditionally: if a concurrent resume already advanced
      // the row out of `waiting-human`, we lose the race and must NOT tear down
      // its worktree (that resume still needs it). Teardown only on the win.
      if (!finalizeParkedWorkflow(deps.db, wf.id, finalState)) continue;
      reconciled++;
      console.error(
        `[reconcile] ${wf.repo}#${wf.epicRef} PR ${life.state} → ${finalState} (workflow ${wf.id})`,
      );
      if (deps.removeWorktree) {
        try {
          await deps.removeWorktree(wf.repo, wf.worktreePath);
        } catch (error) {
          console.error(
            `[reconcile] worktree cleanup failed for ${wf.id} (continuing): ${(error as Error).message}`,
          );
        }
      }
      // Epic #168 hook: a MERGED transition is the moment divergence may have
      // emerged on sibling Epic PRs. Fires at most once per repo per pass
      // (`mergedRepos` guard) so a pass with N MERGED rows on the same repo
      // doesn't fire N concurrent reconcile sweeps. Best-effort and isolated —
      // a throw here never blocks the rest of the parks pass.
      if (life.state === "MERGED" && deps.onMergedTransition && !mergedRepos.has(wf.repo)) {
        mergedRepos.add(wf.repo);
        try {
          await deps.onMergedTransition(wf.repo);
        } catch (error) {
          console.error(
            `[reconcile] onMergedTransition for ${wf.repo} failed (continuing): ${(error as Error).message}`,
          );
        }
      }
    } catch (error) {
      console.error(
        `[reconcile] failed for workflow ${wf.id} (${wf.repo}#${wf.epicRef}): ${(error as Error).message}`,
      );
    }
  }
  return reconciled;
}
