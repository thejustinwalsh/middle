# Decisions — Issue #201

## Two-layer guard: keystone push-refusal + graceful escalation
**File(s):** `packages/dispatcher/src/reconcilers/pr-divergence.ts`
**Date:** 2026-06-03

**Decision:** Guard against the data-loss in two places rather than one.
- **Layer A (keystone) in `applySuccess`:** immediately before the force-push, refuse when `remoteAhead > 0 && localAhead == 0` (the remote branch has the PR's commits, the local HEAD has none). Throws → orchestrator counts `failed`, remote untouched.
- **Layer B (graceful) in `tryRebaseOntoMain`:** detect the dropped-all-commits case after a clean rebase, restore the worktree to its pre-rebase HEAD, and return `droppedAllCommits` so the orchestrator escalates to `applyDemoteToWork` instead of looping on the throw.

**Why:** Layer B gives the operator-visible outcome the issue asks for (escalation, PR flipped to draft, sub-issue reopened) and is atomic (worktree restored). Layer A is the defense-in-depth that makes the data-loss *unreachable* regardless of which upstream step (a future bug, an edge in the merge path) produced an emptied HEAD. The push is the single destructive operation; guarding it directly is the load-bearing guarantee. Belt and suspenders is justified here because the cost of a miss is silent destruction of approved work.

## Gate on "remote had commits to lose", not a blanket `rev-list --count main..HEAD > 0`
**File(s):** `packages/dispatcher/src/reconcilers/pr-divergence.ts` (`applySuccess`)
**Date:** 2026-06-03

**Decision:** The issue's suggested assertion was `git rev-list --count main..HEAD > 0` (local HEAD must be ahead of main). I refined it to `remoteAhead > 0 && localAhead == 0`.

**Why:** A blanket "local must be ahead of main" false-flags a legitimate pure-behind fast-forward of a PR with no own commits (the existing `applySuccess` "pushes the rebased branch" integration test models exactly this: feature at the seed, main advanced → FF → `localAhead == 0`, but nothing was lost because there was nothing ahead to begin with). Gating on the remote *having commits to lose* is strictly safer: it still catches every emptying push (the data-loss case has `remoteAhead > 0`) without breaking the benign FF. Evidence: the existing FF test passes unchanged under the refined condition.

## Skip the merge fallback on `droppedAllCommits`; escalate directly
**File(s):** `packages/dispatcher/src/reconcilers/pr-divergence.ts` (`reconcileOpenPRs`)
**Date:** 2026-06-03

**Decision:** When the rebase reports `droppedAllCommits`, the orchestrator does NOT attempt the `-X ours` merge fallback; it routes straight to `applyDemoteToWork` with a specific reason.

**Why:** If the rebase emptied the branch, the PR's diff is already in `main`. A `-X ours` merge would "succeed" by creating a noise merge commit and pushing a redundant fold-in of already-merged work — auto-resolving a situation a human should look at (is the PR genuinely redundant, or did something go wrong?). The issue's guidance is to escalate, not auto-resolve, when the rebase signals something pathological. The merge fallback remains for the genuine same-line-conflict case it was built for.

## `resetHard` is restore-only, never reset-toward-main
**File(s):** `packages/dispatcher/src/reconcilers/pr-divergence.ts` (`GitOps.resetHard`)
**Date:** 2026-06-03

**Decision:** Added `resetHard` to `GitOps`, documented and used **only** to undo a local rebase back to the captured pre-rebase HEAD.

**Why:** `git reset --hard` toward `main`'s tip is the exact operation that caused #182. Adding it as a general op is mild risk, so it's narrowly scoped: the single call site passes a sha captured *before* the rebase mutated anything, restoring prior state. The docstring forbids the reset-toward-main use explicitly so a future edit doesn't repurpose it.
