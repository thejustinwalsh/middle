# Epic #168: Open-PR reconciler — rebase or demote stale PRs after a main merge

**Link:** https://github.com/thejustinwalsh/middle/issues/168
**Branch:** middle-issue-168

## Goal

When one Epic PR merges to `main`, other open Epic PRs may become non-mergeable. Add an autonomous reconciler that detects that divergence, tries to fix it (rebase first, `-X ours` merge-commit fallback per CLAUDE.md's *new-work-as-base*), and on double-failure demotes the PR back to draft, reopens its last sub-issue, and re-enqueues the Epic — so a ready PR never silently rots between a `main` merge and the human's final-merge gate.

## Approach

- New module: `packages/dispatcher/src/reconcilers/pr-divergence.ts` — the whole reconciler lives here so the chain (classify → rebase → merge-fallback → apply-success / demote) composes from one file's exports.
- Persistence: one new migration `006_pr_divergence_state.sql` adding `pr_divergence_state(pr_number, state, classified_at)`; mirrors the small-row pattern from `005_epics.sql`. `state` widens beyond classifier output to include `DEMOTED`/`SKIPPED` (per #172 / #174).
- Identification: middle-managed PR = head-ref starts with `middle-issue-` (the existing `createWorktree` branch convention). The classifier uses `gh pr view --json mergeable,mergeStateStatus,headRefName` so per-PR cost is one `gh` call.
- Composition: helpers are **pure functions** (no daemon imports). The trigger sibling (#174) is what wires them onto the daemon's poller tick — one place for the sequencing logic so the helpers stay independently testable.
- Integration tests for the git helpers use the same in-process fixture-repo pattern the existing worktree tests use (a real local `git init` + temp worktree, no remote). GitHub-shaped helpers (success/demote) use injected gateway stubs the way `reconcile.test.ts` does.

## Phases

Each phase = one sub-issue. They land on this single branch and PR in this order.

1. **#169 — classify divergence.** Module skeleton + `classifyDivergence(prNumber)` reading `gh pr view --json mergeable,mergeStateStatus`. New migration `006_pr_divergence_state.sql`. Unit tests over each branch of the classifier; SQLite writes round-trip.
2. **#170 — rebase helper.** `tryRebaseOntoMain(prNumber)`: resolve worktree → `git fetch origin main` → `git rebase origin/main` → on conflict, `git rebase --abort` and report conflicting paths. Integration test against a fixture repo with FF / non-FF-no-conflict / conflict cases.
3. **#171 — merge-commit fallback.** `tryMergeMainNewWorkAsBase(prNumber)`: `git fetch origin main` + `git merge -X ours origin/main` (approximates new-work-as-base — branch's version wins on conflict so main's net-new lands on top). On the rare structural conflict `-X ours` can't auto-resolve, `git merge --abort` + return paths. Fixture-repo integration test for both paths.
4. **#172 — applySuccess.** `applySuccess(prNumber, resolution, mainCommitSha)`: `git push --force-with-lease`, post one PR comment (`🔁 Reconciled with main (...) after <sha[:9]>`), update `pr_divergence_state → CLEAN`. Idempotent (no double-push, no double-comment) — verified via gateway stub recording exact call counts.
5. **#173 — applyDemoteToWork.** `applyDemoteToWork(prNumber, conflictingPaths)`: convert PR → draft, identify Epic from sub-issue parent hierarchy, reopen most-recently-closed sub-issue with an escalation comment, post the same comment on both Epic and PR (dual-surface per CLAUDE.md), re-enqueue the Epic through the recommender entry point (so ranking still applies), set state → `DEMOTED`. Idempotent across re-calls.
6. **#174 — wire trigger.** `reconcileOpenPRs()` orchestrator that lists open middle-managed PRs (`headRefName ~ /^middle-issue-/`) and runs the chain. Wire into `poller-cron.ts` alongside `reconcileMergedParks`, with one **immediate sweep** when the existing MERGED-PR detection observes a transition. Rate-limit-aware skip (records `SKIPPED`). End-to-end integration test on a two-PR fixture: merge of one triggers reconciliation of the other; rerunning is idempotent.

## Files likely to change

- `packages/dispatcher/src/reconcilers/pr-divergence.ts` — **new module** (the whole reconciler; classifier + helpers + orchestrator).
- `packages/dispatcher/src/db/migrations/006_pr_divergence_state.sql` — **new migration**.
- `packages/dispatcher/src/poller-gateway.ts` — extend the gateway with the small surface the reconciler needs (`getMergeability`, `listOpenManagedPrs`, `pushForceWithLease`, `postPrComment`, `convertPrToDraft`, `reopenIssue`, `lastClosedSubIssue`, `headSha`, `enqueueEpic`). Keep narrow; mirror the existing inject-able gateway pattern.
- `packages/dispatcher/src/github.ts` — only if a needed surface (PR comment post, draft conversion, reopen) doesn't already exist; reuse where it does.
- `packages/dispatcher/src/poller-cron.ts` — call `reconcileOpenPRs` per tick + on the MERGED-transition path. Keep the existing pass isolation (`try`/`catch` per pass).
- `packages/dispatcher/src/main.ts` — wire the reconciler's deps into the daemon's `startPoller` call (no public-surface change; reuses the existing `repoPaths` registry for `repoPath`).
- `packages/dispatcher/test/pr-divergence.test.ts` — **new tests**, one per phase, mirroring `reconcile.test.ts` and `poller.test.ts` patterns.
- `packages/dispatcher/test/pr-divergence-integration.test.ts` — **new integration tests** for the git helpers (real fixture repo via `git init`, no remote).
- `packages/dispatcher/src/index.ts` — add re-exports per the module-index frontmatter convention.

## Out of scope

- Cross-repo handling — sticks to the current `[repo]` config (sister to #158, which is splitting that policy out; not blocking).
- Migration to a configurable head-ref convention — the `middle-issue-` prefix is hard-coded for now; #158 will lift it into `[repo]`.
- New ranking logic — re-enqueue goes through the existing recommender path so ranking is unchanged.
- Watchdog-style live remediation — this is a poller-tick reconciliation, not a real-time hook.

## Open questions

- **Enqueue entry point for demote (#173).** The recommender's existing path (`runRecommenderForRepo` → state issue → auto-dispatch) is the documented one. Will use it directly via a daemon-injected `enqueueEpic(repo, epicNumber)` callback that triggers a recommender run + `scheduleAutoDispatch(repo)`. If a finer-grained "force this exact Epic" seam is wanted, sub-issue #173 will surface it; otherwise the recommender's own ranking handles it.
- **`pr_divergence_state` row identity.** Issue says `pr_number`; the schema is single-repo by current convention. Will key on `pr_number` PRIMARY KEY (matching the spec) since the daemon today operates one repo per managed checkout. If cross-repo becomes real, a follow-up widens to composite `(repo, pr_number)` — flagged in the row's TSDoc.
