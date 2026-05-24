# Decisions — Issue #32 (Human-in-the-loop + review-driven resume)

## bunqueue cannot express the spec's nested waitFor graph; use a top-level waitFor spine
**File(s):** `packages/dispatcher/src/workflows/implementation.ts`
**Date:** 2026-05-23

**Decision:** Model park/resume as a **top-level `waitFor` node** reached after a branch, with
additional review rounds achieved by re-enqueue — not as `.path((w) => w.step().waitFor().step())`
as the build spec's idealized example shows.

**Why:** The installed `bunqueue@2.7.12` `Workflow` builder filters branch `.path()` bodies and
loop (`doUntil`/`doWhile`/`forEach`) bodies to `type === 'step'` only (`workflow.js:46-48, 83-85`).
A `waitFor` nested inside a path or loop is **silently dropped** — it never executes. The executor
also has no goto/loop-back: `advance()` only moves forward or completes. So a `waitFor` only works
as a top-level node in the workflow's `nodes` array. The spec's annotation `// and loop back via
re-enqueue` confirms re-enqueue was always the intended looping mechanism.

**Evidence:** `node_modules/.bun/bunqueue@2.7.12*/dist/client/workflow/workflow.js:39-51` (path
filters to steps), `executor.js:129-138` (runBranch runs path steps inline then advances),
`executor.js:149-181` (runWaitFor), `types.d.ts:51-54` (BranchDefinition.paths is `StepDefinition[]`).

## Conditional parking via pre-seeding `ctx.signals` (by-reference)
**File(s):** `packages/dispatcher/src/workflows/implementation.ts`
**Date:** 2026-05-23

**Decision:** A single top-level `waitFor` follows the outcome branch. Park-worthy outcomes
(asked-question, done) leave the signal unset so the `waitFor` genuinely parks; terminal outcomes
(bare-stop, failed, rate-limited) **pre-seed `ctx.signals[RESUME_EVENT]`** in their branch step so
the same `waitFor` falls through immediately and the workflow finalizes without waiting.

**Why:** A top-level `waitFor` always executes (no skip primitive). `buildContext` returns
`signals: exec.signals` by reference (`runner.js:169-181`), and `runWaitFor` advances when
`exec.signals[node.event] !== undefined` (`executor.js:150`). Mutating `ctx.signals` in a step
therefore satisfies the wait for terminal paths. Validated by a spike against the real embedded
engine before building the production workflow (build-to-learn).

**Evidence:** spike test (see commit); `runner.js:178`, `executor.js:150`.

## One generic engine event name; epic-specific naming lives in `waitfor_signals`
**File(s):** `packages/dispatcher/src/workflows/implementation.ts`, `workflow-record.ts`
**Date:** 2026-05-23

**Decision:** The bunqueue `waitFor` uses a single constant event string (`"resume"`). The
durable, poller-facing name (`epic-<n>-answered` / `epic-<n>-review-resolved`) is the
`waitfor_signals.signal_name`. The poller looks up the workflow by its armed row and calls
`engine.signal(workflowId, "resume", payload)` regardless of reason; the reason + data ride in the
payload and the DB row.

**Why:** `waitFor(event)` takes a **static string** in this bunqueue version (not the spec's
`(ctx) => ...`), and `engine.signal` already targets a specific execution by id, so the event name
need not be parameterized to avoid cross-execution signal collisions. This keeps the workflow
definition static while preserving the epic-scoped, reason-scoped naming the poller and dashboard need.

**Evidence:** `workflow.d.ts:24` (`waitFor(event: string, ...)`), `executor.js:83-97` (signal
targets one execution), spec §"implementation workflow".

## Poller idempotency via a `fired_at` column; detect-only, interpret in #36
**File(s):** `packages/dispatcher/src/poller.ts`, `db/migrations/002_waitfor_fired.sql`
**Date:** 2026-05-24

**Decision:** The poller is a pure pass over parked workflows (`waiting-human` + an
armed `waitfor_signals` row) behind an injected `GitHubPollGateway`, mirroring the
`watchdog.ts` / `state-issue.ts` gateway pattern. It *detects and fires* only — it
classifies the trigger (new non-bot reply; review verdict) and calls `fireSignal`;
the resume step (#36) interprets the payload. Idempotency is a `fired_at` column on
`waitfor_signals`: a fired wait is skipped until the workflow resumes and a fresh
park (next round) deletes-and-reinserts the row.

**Why:** Keeps the poller unit-testable without `gh` and keeps "what to do on resume"
(round cap, threads into the prompt, terminate-on-resolved) in one place (#36). The
0-actionable-re-review-counts-as-resolved rule lives in the classifier because the
poller must decide *whether* to fire and *what outcome* to report — a bot reviewer
often won't flip `CHANGES_REQUESTED → APPROVED`, so without it the loop would hang.

**Evidence:** `poller.test.ts` (15 tests); acceptance §#35.

## Poller wired into `main.ts`; cross-process resume hosting is Phase 8
**File(s):** `packages/dispatcher/src/main.ts`, `poller-cron.ts`
**Date:** 2026-05-24

**Decision:** `startPoller` runs as a 60s bunqueue cron in the long-running dispatcher
alongside the watchdog, with `fireSignal = (id, p) => engine.signal(id, RESUME_EVENT, p)`.

**Why:** The poller and the signal-delivery seam belong in the persistent process. But
today dispatches run through `dispatchEpic`'s throwaway engine (which drains when the
workflow parks — `waitForSettle` returns on `waiting`), so a parked execution does not
yet live on `main.ts`'s engine to be resumed. Routing dispatches through the persistent
engine + durable bunqueue + `recover()` is the **Phase 8 auto-dispatch** integration
(explicitly out of scope for Phase 5). Wiring the seam now keeps it ready; until Phase 8,
`fireSignal` for a not-yet-hosted execution is caught by the poller's per-workflow guard
and retried — it never crashes the pass.

**Evidence:** `dispatch.ts:42-55` (`waitForSettle` returns on non-running/non-compensating,
i.e. `waiting`); spec §"Phase 8 — Auto-dispatch + limits".
