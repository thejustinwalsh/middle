# Decisions — #253 park-escalation + non-destructive ceiling

## The `waitFor` is left timeout-free instead of "raised to 90 days"
**File(s):** `packages/dispatcher/src/workflows/implementation.ts:159` (constant), `:~1341` (`.waitFor`)
**Date:** 2026-06-23

**Decision:** Remove the `timeout:` from the top-level `.waitFor(RESUME_EVENT)`
entirely, and keep `WAITFOR_TIMEOUT_MS = 90 days` only as the *documented*
non-destructive ceiling (asserted by a unit test, consumed by `runParkEscalation`
as a threshold clamp).

**Why:** The criterion asks for a "non-destructive ceiling (90 days)" and (in
criterion 2) "the worktree is preserved, never compensated/destroyed at the
ceiling." Two hard facts make literally setting `.waitFor({ timeout: 90d })` the
*wrong* fix:
1. **Any finite bunqueue waitFor timeout is destructive.** When bunqueue's waitFor
   timeout elapses it runs the saga's compensate handler (`cleanupWorktree`),
   which kills the tmux session and destroys the worktree. There is no
   "non-destructive finite timeout" in bunqueue — so a 90-day timeout would still
   destroy the worktree at 90 days, violating criterion 2.
2. **90 days overflows `setTimeout`'s 32-bit limit.** `90*24*3600*1000 = 7.776e9`
   ms exceeds `2^31-1 ≈ 2.147e9` ms (~24.85 days). bunqueue's `scheduleTimeoutCheck`
   passes the remaining time straight to `setTimeout`, which clamps an
   over-limit duration to **1 ms** (`TimeoutOverflowWarning`). The waitFor re-check
   guard (`Date.now() - waitingSince >= timeout`) then correctly declines to time
   out, recomputes `remaining ≈ 90d`, reschedules → 1 ms → **a `wf:step` busy-loop
   firing ~1000×/second for the entire park.** Observed directly as the warning in
   the test run before the fix.

A timeout-free `.waitFor` is the only shape that is both non-destructive (no
compensation ever fires) and overflow-free. The park is resolved by the poller
firing `engine.signal` (a human reply / review verdict), by `reconcileMergedParks`
(PR merged/closed), by manual `mm resume`, or surfaced by `runParkEscalation`.

**Evidence:** `node_modules/.../bunqueue/dist/client/workflow/executor.js`
`runWaitFor` (compensates on timeout) + `scheduleTimeoutCheck` (raw `setTimeout`);
`(2**31-1)/86400000 = 24.855 days`. The pre-fix test emitted
`TimeoutOverflowWarning: 7775999996 does not fit into a 32-bit signed integer`.

## Reuse `loadPollableWaits` (armed waits) as the escalation working set
**File(s):** `packages/dispatcher/src/park-escalation.ts`
**Date:** 2026-06-23

**Decision:** Escalate over `loadPollableWaits` rows (`waiting-human` + an armed,
not-yet-fired `waitfor_signals` row) past the threshold.

**Why:** The parks *at risk of the timeout-destroy path* are exactly the
signal-armed parks that re-enter the `.waitFor` (asked-question / review-changes).
Round-cap parks arm no signal and complete the bunqueue execution (they pass the
`.waitFor` and `return` from `resume-or-finalize`), so they were never subject to
the timeout in the first place — correctly outside this set. Reusing the existing
loader keeps one definition of "a parked, armed, unanswered wait" and gives the
arm time (`created_at`) as the staleness proxy, mirroring the CI-pending
escalation's threshold-vs-arm-time pattern.

## Event recorded only after a successful post (idempotent, retry-safe)
**File(s):** `packages/dispatcher/src/park-escalation.ts`
**Date:** 2026-06-23

**Decision:** `park.escalated` is the idempotency key (post exactly once), but it
is recorded **only after** a successful `postEpicComment`. An absent poster seam or
a failed comment records nothing.

**Why:** Recording the marker before/without a successful post would silently
suppress an escalation that never reached GitHub — the exact silent-failure class
#253 is about. Recording after the post means a transient `gh` failure simply
retries next tick. The comment carries `AGENT_COMMENT_MARKER` so the
answered-question poller never mistakes middle's own escalation for the human's
reply (`classifyNewHumanReply` filters `startsWith(marker)`).

## Hung off the existing poller cron, not a new cron
**File(s):** `packages/dispatcher/src/poller-cron.ts`
**Date:** 2026-06-23

**Decision:** Run `runParkEscalation` as one more guarded pass inside `startPoller`,
reusing the already-wired `postEpicComment` + clock; threshold configurable via
`StartPollerOptions.parkStalenessMs` (daemon default = 7 days).

**Why:** Escalation is not latency-sensitive (a 7-day threshold), so it needs no
dedicated cadence. The poller cron already carries the `postEpicComment` seam and
the per-pass guard pattern, so this is a minimal, consistent addition.
