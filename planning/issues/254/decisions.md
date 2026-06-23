# Decisions — Issue #254

## Dep name: postRoundCapEscalation vs postRoundCap
**File(s):** `packages/dispatcher/src/workflows/implementation.ts`
**Date:** 2026-06-23

**Decision:** Name the dep `postRoundCapEscalation` and its default factory `makeDefaultPostRoundCapEscalation`.
**Why:** Mirrors the `postQuestion` naming convention exactly. `postRoundCap` would be too terse given `postQuestion` is the precedent. `Escalation` is accurate — this is the point the workflow escalates to a human.
**Evidence:** `postQuestion` / `makeDefaultPostQuestion` in `build-deps.ts:105`.

## Event type: "workflow.round-cap"
**File(s):** `packages/dispatcher/src/workflows/implementation.ts`
**Date:** 2026-06-23

**Decision:** Use `"workflow.round-cap"` as the event type string.
**Why:** The issue body specifies it explicitly ("record a `workflow.round-cap` event"). The existing prefix pattern is `watchdog.*` for watchdog events; `workflow.*` is the natural prefix for workflow-level state transitions not produced by the watchdog.
**Evidence:** Issue body acceptance criterion 2; `IDLE_EVENT = "watchdog.idle"` precedent in `watchdog.ts:96`.

## Export event type constant
**File(s):** `packages/dispatcher/src/workflows/implementation.ts`
**Date:** 2026-06-23

**Decision:** Export `ROUND_CAP_EVENT = "workflow.round-cap"` as a const alongside `RESUME_EVENT`.
**Why:** Follows `RESUME_EVENT` and `IDLE_EVENT`/`FAILED_EVENT` pattern — the type string is imported in tests for assertion equality rather than hardcoded in two places.
**Evidence:** `RESUME_EVENT` import in `implementation-workflow.test.ts:31`.

## Comment format: standalone formatter, not reusing formatPauseComment
**File(s):** `packages/dispatcher/src/build-deps.ts`
**Date:** 2026-06-23

**Decision:** Add a separate `formatRoundCapComment(cap: number, round: number): string` rather than extending `formatPauseComment`'s union type.
**Why:** The round-cap message is structurally different (no question/context, names the cap), and forcing it into `formatPauseComment` would widen an already-wide union for a single caller. The idempotency guard (`postQuestionComment`) is reused via `postQuestionComment` with the round-cap body — the guard's logic cares about the body string, not the kind.
**Evidence:** `formatPauseComment` signature in `build-deps.ts:40-58`.
