# Issue #179: fix(dispatcher): mm dispatch fails when the Epic's branch already exists

**Link:** https://github.com/thejustinwalsh/middle/issues/179
**Branch:** middle-issue-179

## Goal
Make `createWorktree` honest to its idempotency claim: give me a worktree for this branch, reusing the branch if it already exists. And make a failed prepare-worktree leave a *terminal* workflow row so it can't 409-block the next dispatch.

## Approach
- In `createWorktree`, detect whether the branch ref already exists (`git rev-parse --verify refs/heads/<branch>`) and pick the `git worktree add` form accordingly: `add <path> <branch>` (reuse) vs `add <path> -b <branch>` (create). This is the proposed fix from the issue.
- In the implementation workflow's `prepareWorktree` step, the middle `workflows` row is created (`pending`) *before* `createWorktree` runs. bunqueue's saga only compensates *completed* steps, so a throw inside `prepareWorktree` strands the row at `pending` — and a `pending` row is non-terminal, so the 409 active-workflow guard blocks every later dispatch. Wrap the worktree creation so a failure flips the row to `failed` (terminal) before rethrowing. That clears both the DB 409 guard and the in-memory `inFlightEpics` reservation (released on the `failed` broadcast).

## Phases
1. createWorktree branch reuse — detect an existing branch ref; reuse it instead of always passing `-b`. (criteria 1–3)
2. Orphan-row cleanup — a failed prepare-worktree flips the row `pending → failed`. (criterion 4)

## Files likely to change
- `packages/dispatcher/src/worktree.ts` — branch-exists detection in `createWorktree`
- `packages/dispatcher/test/worktree.test.ts` — reuse-existing-branch, fresh-branch, round-trip tests
- `packages/dispatcher/src/workflows/implementation.ts` — `prepareWorktree` flips the row to `failed` on createWorktree failure
- `packages/dispatcher/test/implementation-workflow.test.ts` — prepare-worktree failure leaves a terminal row

## Out of scope
- The "branch already checked out in another worktree" failure mode (`fatal: '<b>' is already used by worktree at …`). The 409 guard prevents two concurrent dispatches of the same Epic, so a legitimate dispatch never hits a branch checked out elsewhere; surfacing it as a clear `WorktreeError` (already the case) is sufficient. The reconciler owns stale-registration cleanup.

## Open questions
- None — the issue's proposed fix is concrete and the secondary clean-up is specified.
