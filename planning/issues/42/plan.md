# Issue #42: Recommender workflow (Epic — Phase 7)

**Link:** https://github.com/thejustinwalsh/middle/issues/42
**Branch:** middle-issue-42

## Goal
Ship Phase 7 of the build spec: the `recommender` bunqueue workflow that rewrites a
repo's state issue with a ranked dispatch plan. Read-only at first — the recommender
writes the state issue; nothing auto-dispatches yet (`trigger-auto-dispatch` is inert).

## Approach
- Mirror the existing `implementation` workflow's shape: a factory
  (`createRecommenderWorkflow(deps)`) returning a `Workflow<RecommenderInput>`, with all
  collaborators injected so tests use stubs (no `gh`/tmux/git needed). Source of truth
  for the step list is the spec's `recommenderWorkflow` block.
- The recommender records its workflow row with `kind: "recommender"` (already in the
  schema). Slot accounting for `build-prompt`'s injected `slots` counts only
  `kind = "implementation"` non-terminal rows — so the recommender's own run is its own
  dedicated slot, never counted against `maxConcurrent`. That is the testable
  "dedicated-slot" behavior.
- `build-prompt` assembles the recommender prompt from **dispatcher-owned** context
  (rate limits, in-flight, slots) read verbatim from dispatcher state — the recommender
  does not recompute them — plus `repo`, `state_issue`, `schema_path`, `prior_body`,
  `config`. The agent is pointed at the on-disk `schema_path`.
- `verify-state-issue-parses` re-reads the produced body and runs it through
  `parseStateIssue` + `validate`; failure surfaces to a human and gates
  `trigger-auto-dispatch` (which is inert this phase anyway).
- `mm run-recommender <repo>` runs the workflow to settle (mirrors `mm dispatch` →
  `dispatchEpic` with an ephemeral engine). A dispatcher HTTP trigger endpoint exists so
  a dashboard button can fire the same run (dashboard UI itself is Phase 9, left stubbed).
- TDD throughout (`test-driven-development`): each step's behavior gets a failing test first.

## Phases (one per open sub-issue)
1. **#43** — `recommender` workflow shell: all seven steps wired in order,
   `prepare-shallow-worktree` compensation, 5-min hard cap on `spawn-recommender-agent`,
   dedicated-slot accounting. Test asserts step order + dedicated-slot behavior.
2. **#44** — `build-prompt` step content: assemble every required input
   (`repo`, `state_issue`, `schema_path`, `prior_body`, `rate_limits`, `in_flight`,
   `slots`, `config`), dispatcher-owned bits verbatim, schema path on disk. Test asserts
   the assembled prompt contains every required input.
3. **#45** — `verify-state-issue-parses` step content: fetch body → `parseStateIssue` +
   `validate`; on failure don't proceed to auto-dispatch and surface to a human; on
   success continue. Tests cover a valid produced body and a malformed one.
4. **#46** — `mm run-recommender <repo>` CLI command + dispatcher trigger endpoint
   (read-only: `trigger-auto-dispatch` dispatches nothing). Test asserts the CLI enqueues
   a recommender workflow for the repo.
5. **#47** — Hand-eyeball recommender runs against middle's own repo, iterate the
   `recommending-github-issues` skill text for observed gaps, capture a written record of
   what changed and why.

## Files likely to change
- `packages/dispatcher/src/workflows/recommender.ts` — new workflow (factory + deps + steps).
- `packages/dispatcher/test/recommender-workflow.test.ts` — new test (#43–#45).
- `packages/dispatcher/src/recommender.ts` (or `dispatch.ts` sibling) — `dispatchRecommender`
  runner (ephemeral engine), used by the CLI and the trigger endpoint.
- `packages/dispatcher/src/hook-server.ts` — optional injected recommender-trigger route.
- `packages/cli/src/commands/run-recommender.ts` + `packages/cli/src/index.ts` — CLI wiring.
- `packages/cli/test/...` — CLI command test.
- `packages/cli/src/bootstrap-assets/skills/recommending-github-issues/SKILL.md` — #47 prompt iteration.

## Out of scope
- The auto-dispatch loop becoming active (Phase 8) — `trigger-auto-dispatch` stays inert.
- Full dashboard UI (Phase 9) — only the dispatcher endpoint exists; the route is stubbed.
- Editing the recommender workflow *mechanics* during #47 (that's #43–#46).

## Open questions
- None blocking. `schema_path` for middle's own repo is `schemas/state-issue.v1.md` (repo root).
