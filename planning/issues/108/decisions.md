# Decisions — Issue #108

## Fix at the source: idempotent `createWorkflowRecord` over per-step `retry: 1`
**File(s):** `packages/dispatcher/src/workflow-record.ts:49`
**Date:** 2026-05-26

**Decision:** Make `createWorkflowRecord` idempotent on the `id` PK rather than adding
`retry: 1` to `prepare-worktree`.

**Why:** Two candidate fixes:
1. `retry: 1` on `prepare-worktree` (mirror the recommender/documentation
   `check-rate-limit` workaround) — but `prepare-worktree`'s `createWorktree` is a
   *legitimately retriable* operation (a transient git failure can succeed on retry).
   `retry: 1` would throw that recovery away to dodge the INSERT problem.
2. Idempotent INSERT — the INSERT is the only thing in the step that isn't safe to
   re-run. The PK is `ctx.executionId`, unique per bunqueue execution, so the *only*
   way the id collides is the same execution retrying — precisely the no-op case. This
   keeps the worktree-creation retry intact and hardens all three record-creating steps
   (implementation, recommender, documentation) at one point.

Chose (2). It preserves the desired retry semantics and fixes the class, not the instance.

**`ON CONFLICT(id) DO NOTHING`, not `INSERT OR IGNORE`:** the issue suggested
`INSERT OR IGNORE`, but that ignores *every* constraint failure — a CHECK (bad `kind`/
`state`) or NOT-NULL violation would be silently swallowed. Scoping the no-op to the
`id` PK conflict keeps a genuine schema-constraint bug throwing while still making the
retry a no-op. Covered by a test asserting a bad `kind` still throws.

**Evidence:** bunqueue's default step `retry` is `3`
(`node_modules/.bun/bunqueue@2.7.12/.../client/workflow/workflow.js:22` →
`options?.retry ?? 3`), and `prepare-worktree` registers with no `retry` override
(`implementation.ts:966`), so it genuinely retries. The unit test in
`workflow-record.test.ts` ("idempotent on retry") reproduces the masking UNIQUE before
the fix; the workflow test in `implementation-workflow.test.ts` ("prepare-worktree
survives a step retry") proves a transient `createWorktree` failure now recovers to
`completed` instead of failing on a masked UNIQUE.

**Left in place:** the existing `retry: 1` on the recommender/documentation
`check-rate-limit` steps. They have an independent rationale (a deterministic db-state
check gains nothing from retrying) and are now belt-and-suspenders rather than the
load-bearing guard. Removing them is out of scope.
