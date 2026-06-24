# Issue #253: 7-day waitFor timeout silently destroys worktree instead of escalating

**Link:** https://github.com/thejustinwalsh/middle/issues/253
**Branch:** middle-issue-253

## Goal
Decouple park *duration* from accidental worktree *destruction*: raise the `waitFor`
timeout to a non-destructive 90-day ceiling, and add a staleness-escalation pass
that notices a long-parked `waiting-human` Epic, escalates it on GitHub, and
**preserves** the worktree instead of letting the timeout compensate it away.

## Approach
- **Constant bump (criterion 1):** `WAITFOR_TIMEOUT_MS` 7d → 90d in
  `workflows/implementation.ts`, exported so a unit test can pin it. The timeout
  still exists (a real backstop) but is now far past any human-review cadence, so
  it stops being the de-facto park ceiling that destroys work.
- **Escalation pass (criterion 2):** a new `park-escalation.ts` pass over armed,
  not-yet-fired `waiting-human` waits (`loadPollableWaits`). A wait whose arm time
  exceeds a configurable threshold (default 7 days) and that hasn't been escalated
  yet gets one Epic comment + a `park.escalated` event; the worktree is never
  touched. Idempotent via `hasEventOfType` (post once). The comment carries the
  `AGENT_COMMENT_MARKER` so the answered-question poller never mistakes middle's own
  escalation for a human reply.
- **Wiring:** hang the pass off the existing poller cron (`startPoller`) — no new
  cron — reusing the already-wired `postEpicComment` seam; threshold configurable
  via a `parkStalenessMs` option (daemon default = 7 days).
- **Why reuse `loadPollableWaits`:** the rows at risk of the timeout-destroy path
  are exactly the signal-*armed* parks that re-enter the `.waitFor` (asked-question
  / review-changes). Round-cap parks arm no signal and complete the bunqueue exec,
  so they're never subject to `WAITFOR_TIMEOUT_MS` — correctly out of this set.

## Phases
1. Raise + export `WAITFOR_TIMEOUT_MS` (90d); unit test pins the constant.
2. `runParkEscalation` pass + unit tests (comment + event + worktree-preservation,
   idempotency, threshold boundary, agent-marker); wire into the poller cron + daemon.
3. Integration test: boot the poller cron, drive a real `waiting-human` park past
   the threshold on the real path, assert escalation comment dispatched (test gh
   seam) AND worktree still present on disk (no compensate ran).

## Files likely to change
- `packages/dispatcher/src/workflows/implementation.ts` — bump + export the constant.
- `packages/dispatcher/src/park-escalation.ts` — **new** escalation pass.
- `packages/dispatcher/src/poller-cron.ts` — run the pass each tick (guarded).
- `packages/dispatcher/src/main.ts` — wire the daemon threshold default.
- `packages/dispatcher/test/park-escalation.test.ts` — **new** unit tests.
- `packages/dispatcher/test/implementation-workflow.test.ts` (or new integration file) —
  timeout-constant pin + the real-path escalation integration test.

## Out of scope
- A distinct `needs-attention` state — escalation reuses `waiting-human` (per issue).
- The slot-accounting change for parked epics (W1, separate sub-issue).

## Open questions
- None blocking. Threshold default (7 days) and ceiling (90 days) are taken
  verbatim from the acceptance criteria.
