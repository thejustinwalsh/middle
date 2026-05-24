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
