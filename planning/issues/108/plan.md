# Issue #108: implementation workflow: prepare-worktree can hit UNIQUE on step retry

**Link:** https://github.com/thejustinwalsh/middle/issues/108
**Branch:** middle-issue-108

## Goal
Make the record-creating workflow steps survive a bunqueue retry: a retried step that already INSERTed its `workflows` row must surface the *real* error, not a masking `UNIQUE constraint failed`.

## Approach
- The bug: `createWorkflowRecord` is a plain `INSERT`. `prepare-worktree`
  (`implementation.ts`) registers with bunqueue's **default `retry: 3`** and calls
  `createWorkflowRecord` first, then `createWorktree` (which can throw on a transient
  git failure). On retry the step re-runs from the top → re-INSERTs the same
  primary-key `id` → `UNIQUE constraint failed`, masking the worktree error.
- The recommender/documentation `check-rate-limit` steps dodged this with `retry: 1`,
  but that's a per-step workaround, not a fix — and `prepare-worktree` legitimately
  *wants* to retry the worktree creation.
- **Fix at the source:** make `createWorkflowRecord` idempotent on the `id` PK with
  `INSERT ... ON CONFLICT(id) DO NOTHING`. The only way the same `id` (= bunqueue
  `executionId`, unique per execution) collides is the same execution retrying — exactly
  the case we want to no-op. A retried record-creating step becomes a no-op on the INSERT
  and the real downstream error surfaces. Scoped to the PK conflict (not a blanket
  `INSERT OR IGNORE`) so a genuine CHECK/NOT-NULL violation still throws. Hardens all
  three workflows (implementation, recommender, documentation) at one point.
- Leave the existing `retry: 1` annotations in place — they have an independent
  rationale (a deterministic db-state check has nothing to gain from retrying) and
  are now belt-and-suspenders, not load-bearing.

## Phases
1. Idempotent createWorkflowRecord + tests — `INSERT OR IGNORE`, unit test for the
   double-create no-op, and a workflow-level test that a retried record-creating step
   surfaces the real error instead of UNIQUE.

## Files likely to change
- `packages/dispatcher/src/workflow-record.ts` — `INSERT` → `INSERT ... ON CONFLICT(id) DO NOTHING` in `createWorkflowRecord`, with a doc note on the idempotency contract.
- `packages/dispatcher/test/workflow-record.test.ts` — unit test: second create with same id is a no-op (no throw, first row preserved).
- `packages/dispatcher/test/implementation-workflow.test.ts` — retry test: `prepare-worktree` whose `createWorktree` throws once retries and surfaces that error, never a UNIQUE.

## Out of scope
- Removing the `retry: 1` on `check-rate-limit` (recommender/documentation) — independent rationale, left as defense-in-depth.
- Durable bunqueue persistence (#116).

## Open questions
- None. The issue names the fix (`INSERT OR IGNORE`) and the test to add; the approach matches.
