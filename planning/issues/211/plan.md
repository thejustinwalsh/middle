# Issue #211: fix(dispatcher): multi-repo coordination — close the real holes

**Link:** https://github.com/thejustinwalsh/middle/issues/211
**Branch:** middle-issue-211

## Goal
Close the three real multi-repo coordination holes the audit found: cross-repo Epic
blockers ignored at runtime (#225), no collision guard for a shared checkout path (#226),
and a hung recommender on one repo stalling the others (#227). One Epic, one PR.

## Approach
- **#225 — runtime blocker resolution.** Add a deterministic post-agent step to the
  recommender workflow that parses each `BlockedItem.blocker`, resolves issue refs
  (`#<n>` same-repo, `<owner>/<repo>#<n>` cross-repo) through the routing `EpicGateway`,
  and reclassifies: blocker closed → Ready to dispatch; open → stays Blocked (annotated
  with the resolved title); unresolvable (404 / file-mode slug missing) → stays Blocked
  with a `(stale blocker: <ref>)` suffix. Backticked descriptions stay blocked. Needs a
  new `getIssueState(repo, ref)` gateway method (github via `gh`, file via the Epic file).
- **#226 — collision guard.** `registerManagedRepo` throws a typed `RepoPathCollisionError`
  when a *different* repo slug is already registered for the same checkout path (same-repo
  re-register stays idempotent). `mm init` runs the guard *before* scaffolding so the
  second repo's `.middle/<slug>.toml` is never written; the dispatch route maps the typed
  error to a 400.
- **#227 — parallel recommender cron.** `runRecommenderCronPass` stamps all due repos, then
  fires their runs concurrently behind a hand-rolled limiter (`maxConcurrentRepos`, default
  4), each wrapped in a per-repo timeout (default 60s). A hang/throw on one repo is isolated
  (stamp rolled back) and never blocks the others.

## Phases (one per open sub-issue)
1. **#225** — `BlockedItem.blocker` runtime resolution (cross-repo unblock)
2. **#226** — repo_config collision guard (reject `mm init` on shared checkout_path)
3. **#227** — parallelize the recommender cron per-repo

## Files likely to change
- `packages/dispatcher/src/github.ts` — add `getIssueState` to `EpicGateway` + `ghGitHub`
- `packages/dispatcher/src/epic-store/file-epic-gateway.ts` — file-backed `getIssueState`
- `packages/dispatcher/src/epic-store/index.ts` — route `getIssueState`
- `packages/dispatcher/src/blocker-resolution.ts` — **new**, pure ref-parse + reclassify
- `packages/dispatcher/src/workflows/recommender.ts` — new `resolve-blockers` step
- `schemas/state-issue.v1.md` — document cross-repo blocker syntax + resolution semantics
- `packages/dispatcher/src/repo-config.ts` — `RepoPathCollisionError` + guard in `registerManagedRepo`
- `packages/cli/src/commands/init.ts` — early collision guard, non-zero exit
- `packages/dispatcher/src/main.ts` — map collision to 400; wire cron concurrency/timeout
- `packages/dispatcher/src/hook-server.ts` — dispatch route → 400 on collision
- `packages/dispatcher/src/recommender-cron.ts` — concurrent pass with per-repo timeout
- `packages/core/src/config.ts` — `[recommender] max_concurrent_repos`, `run_timeout_seconds`
- New tests: `multi-repo-blockers.test.ts`, `repo-config.test.ts` (extend),
  `recommender-cron-parallel.test.ts`, init collision e2e

## Out of scope
- Cross-repo Epic-*file* references (file mode) — same-repo file refs work; cross-repo is schema-v2.
- Repos sharing a checkout via legitimate git worktrees — two slugs on one checkout is a config error.
- Replacing bunqueue's cron mechanism; adaptive rate-limit-aware concurrency.

## Open questions
- None blocking. The "needs-human if its own criteria are now unmet" branch of #225 is
  implemented as: a resolved (closed) blocker moves the item to **Ready to dispatch** with a
  best-effort row (real sub-issue count + title when the Epic is discoverable); the next full
  recommender agent run re-ranks it. Surfacing to Needs-human requires the item's own
  acceptance-criteria check, which is the agent's job, not deterministic code.
