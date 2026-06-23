# Decisions log — Issue #237: idempotent recommender comments

## Deduper factory: createRecommenderSurfaceProblemDeduper (not inline)

**File:** `packages/dispatcher/src/recommender-run.ts`
**Date:** 2026-06-23

**Decision:** Extracted as a standalone factory function, not inlined into the workflow deps.
**Why:** Mirrors `createParseFailureSurfacer` (same file), which is the established pattern. A factory is testable in isolation and makes the wiring in `main.ts` explicit rather than hidden inside the workflow creation block. The test imports it directly to verify its semantics independently of the full workflow.

## No message-content filter

**File:** `packages/dispatcher/src/recommender-run.ts`
**Date:** 2026-06-23

**Decision:** `createRecommenderSurfaceProblemDeduper` deduplicates ALL problem strings, with no `includes("does not parse")` or similar filter.
**Why:** `createParseFailureSurfacer` has a filter because it lives in the auto-dispatch path where only parse-failure errors should surface on the state issue. The recommender's `surfaceProblem` is already only called for recommender-specific problems (verify/validation failures), so every call is legit; filtering by content would create silent gaps if the message format changes.

## onSurfacerReset placement: cleanupWorktree only on verify.ok

**File:** `packages/dispatcher/src/workflows/recommender.ts`
**Date:** 2026-06-23

**Decision:** `onSurfacerReset` is called from `cleanupWorktree` when `verify.ok === true` (not from `triggerAutoDispatch` or any other step).
**Why:** `cleanupWorktree` is the last step of every run regardless of path (compensation vs. success). Checking `verify.ok === true` ensures we only reset on a genuinely clean run — a run where the produced body was valid. A failed or compensated run must NOT reset (the problem persists). The `verify` step result is available in `ctx.steps` at this point.

## Skill guard: idempotency before comment, write-verification after edit

**File:** `packages/skills/recommending-github-issues/SKILL.md`
**Date:** 2026-06-23

**Decision:** Added two separate guards to Phase 6: (a) write-verification after `gh issue edit` (check `updatedAt` advanced), and (b) idempotency before posting the run-summary comment (fetch last comment, compare).
**Why:** These are two distinct failure modes: (a) a daemon race where our write is silently ignored, (b) duplicate comments from re-runs. The write-verification guard is upstream of the comment guard — if the write was ignored, we stop and don't comment. The comment guard handles the case where the write succeeded but the comment would be a duplicate.
