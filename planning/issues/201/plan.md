# Issue #201: fix(dispatcher): open-PR divergence reconciler reset an approved branch to main and closed the PR (data-loss)

**Link:** https://github.com/thejustinwalsh/middle/issues/201
**Branch:** middle-issue-201

## Goal
Make the open-PR divergence reconciler **non-destructive**: a rebase that drops all of a PR's commits (the failure that silently emptied PR #182) must never be force-pushed over the branch. It is restored locally and routed to the existing escalation (demote-to-work) instead.

## Approach
- The root cause is a `git rebase origin/main` that exits 0 while dropping *every* commit the PR added (each becomes empty against the new main) — leaving local `HEAD == origin/main`. `applySuccess` then force-pushes that empty HEAD over the branch → all approved commits lost. Reproduced locally: `rev-list --count main..HEAD` goes 1→0, exit 0.
- **Layer A — keystone push guard (`applySuccess`):** before the force-push, refuse to push when the remote branch still has commits ahead of `main` but the local HEAD has none (`remoteAhead > 0 && localAhead == 0`). This is the absolute last line — it makes the data-loss unreachable regardless of which upstream step produced the empty HEAD.
- **Layer B — graceful escalation (`tryRebaseOntoMain`):** detect the dropped-all-commits case right after the clean rebase, **restore the worktree to its pre-rebase HEAD** (`git reset --hard <captured>`), and return a non-ok `droppedAllCommits` result so the orchestrator escalates instead of looping on the throw.
- **Orchestrator routing:** on `droppedAllCommits`, skip the `-X ours` merge fallback (it would only re-derive the emptiness or push a noise merge) and call `applyDemoteToWork` with a specific reason — reopen the sub-issue, dual-surface escalation, re-enqueue. The PR is flipped to **draft**, never closed.
- Refine the issue's suggested `rev-list --count main..HEAD > 0` assertion: gate on *the remote had commits to lose*, so a legitimate pure-behind fast-forward of an empty PR isn't false-flagged.

## Phases
1. Non-destructive reconcile guards + escalation routing — `packages/dispatcher/src/reconcilers/pr-divergence.ts`, with regression tests in `packages/dispatcher/test/pr-divergence*.test.ts`.

(Standalone issue — one phase.)

## Files likely to change
- `packages/dispatcher/src/reconcilers/pr-divergence.ts` — add `revListCount` + `resetHard` to `GitOps`; `droppedAllCommits` on `GitResolutionResult`; guard in `tryRebaseOntoMain`; keystone guard in `applySuccess`; `reason` thread through `applyDemoteToWork`/`renderDemoteEscalation`; orchestrator routing.
- `packages/dispatcher/test/pr-divergence-integration.test.ts` — real-git regression: dropped-commits guard restores + escalates, branch not emptied, PR not closed.
- `packages/dispatcher/test/pr-divergence.test.ts` — unit coverage for the reason-threaded escalation message.

## Out of scope
- The historical recovery of PR #182 (already done per the issue).
- Broader reconciler redesign / backoff (#122).

## Open questions
- None — the issue's suggested direction is concrete and the failure reproduces deterministically.
