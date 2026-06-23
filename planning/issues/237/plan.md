# Issue #237: fix(dispatcher): recommender re-posts identical problem comment every interval

**Link:** https://github.com/thejustinwalsh/middle/issues/237
**Branch:** harden/idempotent-comments

## Goal

Stop the recommender workflow from spamming identical problem comments on the state issue every interval when the state issue stays broken. Also add an idempotency guard to the recommender skill's run-summary comment.

## Approach

- Mirror the `createParseFailureSurfacer` dedup pattern (already in `auto-dispatch.ts`) for the recommender's `surfaceProblem` dep
- Add `onSurfacerReset` dep to `RecommenderDeps` so a clean run clears the dedup state (enabling re-posting if the problem recurs after a fix)
- Record only after a successful post (a failed `gh` must not suppress the next attempt)
- TDD: failing tests first, then implementation
- Add idempotency to the SKILL.md Phase 6 comment step

## Phases

1. **Tests** — write two failing tests in `recommender-workflow.test.ts` that expose the problem (and confirm they fail before the fix)
2. **Deduper** — implement `createRecommenderSurfaceProblemDeduper` in `recommender-run.ts` + `onSurfacerReset` on `RecommenderDeps` in `recommender.ts`
3. **Wiring** — wire deduper and `onSurfacerReset` in `main.ts` at the recommender workflow registration (~line 679)
4. **Skill guard** — update `SKILL.md` Phase 6 with idempotency + write-verification instructions; run `bun run sync-skills`

## Files likely to change

- `packages/dispatcher/src/recommender-run.ts` — add `createRecommenderSurfaceProblemDeduper`
- `packages/dispatcher/src/workflows/recommender.ts` — add `onSurfacerReset?` to `RecommenderDeps`, call from `cleanupWorktree`
- `packages/dispatcher/src/main.ts` — wire deduper near line 679
- `packages/dispatcher/test/recommender-workflow.test.ts` — two new tests
- `packages/skills/recommending-github-issues/SKILL.md` — idempotency guard on Phase 6
- `packages/cli/src/bootstrap-assets/skills/recommending-github-issues/SKILL.md` — synced mirror

## Out of scope

- `main.ts:740` orphan-recovery (fires once per boot, not spam) — verified not spam
- `gates/checkbox-revert.ts:151` (gated by headSha+wasChecked) — verified not spam
- `.claude/skills` and `.codex/skills` mirrors — a separate PR owns extending sync to those

## Open questions

- None. The verifier's audit is definitive; scope is exactly the recommender's `surface()` call.
