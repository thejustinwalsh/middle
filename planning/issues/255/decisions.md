# Decisions for #255

## Guard placement: in reconcileOpenPRs, not in resolveWorktreePath
**File(s):** `packages/dispatcher/src/reconcilers/pr-divergence.ts`
**Date:** 2026-06-23

**Decision:** Added the live-worktree check directly in `reconcileOpenPRs` before calling `tryRebaseOntoMain`, rather than in `resolveWorktreePath` or the git helpers.

**Why:** The orchestrator already has `deps.db` and `pr.headRefName`, so the check is a pure, no-new-dependency addition at the right altitude. If the guard were in `resolveWorktreePath`, it would need to change the return type (adding a new discriminant like `{ liveWorkflow: true }`) and every caller would need to handle it. In `reconcileOpenPRs` the logic stays flat: compute path, check DB, continue or skip. The guard is also most readable here — it's clearly part of the orchestrator's per-PR decision flow, not a side-effect buried inside a helper.

## Two variables for epicNumber and worktreePath
**Decision:** Using `liveEpicNumber` / `liveWorktreePath` as locally-scoped names. These only live inside the `try` block of the `for` loop, so shadowing isn't an issue. The names are clear enough — `liveEpicNumber` signals this is specifically for the guard.

## listLiveImplementationWorkflows vs extending listRunningImplementationWorkflows
**Decision:** New function rather than extending the existing one.

**Why:** `listRunningImplementationWorkflows` is the set "the checkbox-revert pass walks" — documented as such with `ORDER BY` semantics for burst-cap ordering. Adding `launching` to it would widen the set and potentially confuse the checkbox-revert pass (which is intentionally only interested in `running` rows that have an active agent session). A separate function with explicit semantics for the reconciler guard is cleaner.
