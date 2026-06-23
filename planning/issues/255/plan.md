# Issue #255: fix(pr-divergence): reconciler enters a live agent's worktree without quiescing it

**Link:** https://github.com/thejustinwalsh/middle/issues/255
**Branch:** fix/reconciler-live-worktree

## Goal

Prevent the open-PR divergence reconciler from running `git rebase` or `git merge` inside a worktree that a live agent currently owns, eliminating the race condition that can silently rewrite branch history mid-commit.

## Approach

- Add a new `listLiveImplementationWorkflows` query to cover both `running` and `launching` states — these are the non-terminal states where an agent actively owns a worktree.
- Before entering `tryRebaseOntoMain` or `tryMergeMainNewWorkAsBase`, check whether any live workflow's `worktree_path` matches the resolved worktree path. Skip the git operation if a match is found, logging at DEBUG.
- Wire the DB from `ReconcileOpenPRsDeps` into `WorktreeOpsDeps` so the guard can query it.
- Write failing tests first (TDD): unit test for the skip behavior, integration test driving the real `reconcileOpenPRs` path against a DB seeded with a `running` workflow row.

## Phases

1. **Failing tests** — Write unit + integration tests that assert the skip; all will fail until the fix lands.
2. **Implementation** — Add `listLiveImplementationWorkflows`, wire db into `WorktreeOpsDeps`, add the guard before rebase/merge callers; make tests green.
3. **Self-review + full gate run** — `bun test`, `bun run typecheck`, `bun run lint`, paste output.

## Files likely to change

- `packages/dispatcher/src/workflow-record.ts` — new `listLiveImplementationWorkflows` function
- `packages/dispatcher/src/reconcilers/pr-divergence.ts` — add optional `db` to `WorktreeOpsDeps`, guard in `tryRebaseOntoMain` / `tryMergeMainNewWorkAsBase`
- `packages/dispatcher/test/pr-divergence.test.ts` — unit test for skip behavior
- `packages/dispatcher/test/pr-divergence-integration.test.ts` — integration test driving real `reconcileOpenPRs`

## Out of scope

- `--force-with-lease` / `droppedAllCommits` hardening (separate follow-ups)
- Terminal/compensated worktree recreation prevention (mentioned as optional in the issue)
