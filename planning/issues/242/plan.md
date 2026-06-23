# Issue #242: feat(dashboard): surface session-ended-before-Stop and Stop-hook-timed-out reasons in Activity run-history UI

**Link:** https://github.com/thejustinwalsh/middle/issues/242
**Branch:** feat/run-history-reasons

## Goal

Surface the two specific abnormal-termination reasons (`session-ended-before-Stop`,
`Stop-hook-timed-out`) in the Activity view's run history with human-readable labels
and tooltips, so operators have actionable signal when these edge cases occur.

## Approach

- Add a DB migration (012) to introduce an `end_reason TEXT` column on `workflows`.
- Write the reason token (before throwing) in both `recommender.ts` and
  `implementation.ts` when the session/timeout race is lost.
- Project `end_reason` from the DB via `listRuns()` in `db-deps.ts`.
- Add `endReason: string | null` to the `RunSummary` wire type.
- Render in `RunRow` with a neutral `Badge` using an HTML `title` tooltip.

## Phases

1. Dispatcher — migration + reason writes + projection (single phase; scope is tight)
2. Dashboard — wire type + `RunRow` rendering + tests

(Implemented as one combined pass since the phases have no parallelism benefit.)

## Files changed

- `packages/dispatcher/src/db/migrations/012_workflows_end_reason.sql` — new column
- `packages/dispatcher/src/workflow-record.ts` — `endReason` in `WorkflowPatch`
- `packages/dispatcher/src/workflows/recommender.ts` — write reason before throw
- `packages/dispatcher/src/workflows/implementation.ts` — write reason before throw
- `packages/dashboard/src/wire.ts` — `endReason` on `RunSummary`
- `packages/dashboard/src/db-deps.ts` — project `end_reason` in `listRuns()`
- `packages/dashboard/src/app/components/Activity.tsx` — render `RunRow` reason chip
- `packages/dashboard/test/activity.test.tsx` — 4 new tests
- `packages/dashboard/test/runs-deps.test.ts` — 1 new DB-level projection test

## Out of scope

- Rendering `endReason` in the Inspector panel (the Activity list is the focus)
- Adding a reason filter/search to the Activity view
- Backfilling historical `compensated` rows (no migration data; new writes only)
