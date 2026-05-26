# Issue #101: Invoke the checkbox-revert reconciler on agent push (production trigger)

**Link:** https://github.com/thejustinwalsh/middle/issues/101
**Branch:** middle-issue-101

## Goal
Wire `reconcileCheckboxes` into production so that after an agent advances its
Epic PR, the dispatcher runs the declared verification gates and reverts a
failing `[ ] → [x]` Status checkbox. Today the reconciler + gate machinery are
fully built and unit-tested, but nothing fires them on a real push.

## Approach
- The reconciler is **GitHub-state-driven** (reads the PR body, diffs checkboxes,
  reverts on the PR). That is the GitHub **poller's** job — the same home as
  `reconcileMergedParks`. The hook server deliberately "doesn't invoke business
  logic" (package CLAUDE.md), and the issue's "keyed on the Epic PR's head SHA
  advancing" framing is a polling check, not an event. So: a **new poller pass**,
  not a Stop hook. (Conventions decide it — not a fork.)
- Keep `poller.ts`'s "never writes to GitHub" invariant intact: the new pass
  lives in its own module (`gates/checkbox-revert-pass.ts`) and takes the
  write-capable `GitHubGateway`, composing the already-built `reconcileCheckboxes`
  + `makeRunPhaseGates` (this is `makeRunPhaseGates`'s first production consumer).
- Run it over **running** implementation workflows (a new query, mirroring
  `listParkedImplementationWorkflows`), head-SHA-gated so an unchanged PR costs
  one cheap `findEpicPr` read and no gate runs.
- Persist the per-workflow `{ headSha, checkboxState }` in the existing
  `meta_json` column (no migration; mirrors how `source` already lives there) via
  typed accessors that merge rather than clobber.
- Reuse the poller's GitHub-friendliness guards (free rate-limit ceiling +
  per-pass burst cap) and per-workflow error isolation.

## Phases
This is a standalone (one-phase) issue. Logical commits:
1. `feat(github)` — add `headSha` to `PullRequest`; populate from `headRefOid` in
   `findEpicPr` / `getPullRequest`.
2. `feat(dispatcher)` — workflow-record: typed `meta_json` accessors
   (`readWorkflowMeta` / `patchWorkflowMeta`, `getCheckboxReconcileState` /
   `setCheckboxReconcileState`), refactor `getWorkflowSource` onto them, and
   `listRunningImplementationWorkflows`. + tests.
3. `feat(dispatcher)` — `runCheckboxRevertPass` (the new module) + tests.
4. `feat(dispatcher)` — wire the pass into the poller cron + `main.ts`.

## Files likely to change
- `packages/dispatcher/src/github.ts` — `PullRequest.headSha`, query fields.
- `packages/dispatcher/src/workflow-record.ts` — meta accessors, running query.
- `packages/dispatcher/src/gates/checkbox-revert-pass.ts` — **new** pass module.
- `packages/dispatcher/src/poller-cron.ts` — run the third pass on the cron.
- `packages/dispatcher/src/main.ts` — pass the write-capable gateway + rate-limit.
- `packages/dispatcher/test/gates/checkbox-revert-pass.test.ts` — **new** tests.
- `packages/dispatcher/test/workflow-record.test.ts` — meta + running-query tests.

## Out of scope
- Replacing the reconciler's checkbox detection/diff/revert mechanics (delivered
  in Phase 4, #41-adjacent — unchanged here).
- The gate machinery itself (`verify.ts` / `gate-runner` / `gate-evidence`,
  #37 — consumed as-is).
- Durable persistence of parked executions across daemon restarts (#116).
- `findEpicPr` listing all open PRs per call (pre-existing; could be made
  `--search`-targeted later — note only).

## Open questions
- None blocking. Latency: the poller cadence (120s) gates this, consistent with
  review-resume; the agent observes the revert+comment on its next PR-status read.
