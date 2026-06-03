# Issue #200: file-mode completeness beyond Phase 1/2 (review-resume, recommender, browse cache)

**Link:** https://github.com/thejustinwalsh/middle/issues/200
**Branch:** middle-issue-200

## Goal
Close the three documented Phase-1/2 file-mode gaps from Epic #190 so a file-backed Epic reaches full parity with a GitHub-backed one: PR-review resume, recommender/auto-dispatch, and browse-cache/dashboard visibility.

## Approach
- The #190 foundation is already in `main` (`packages/dispatcher/src/epic-store/`). Each gap is an independent surface that routes an already-mode-aware seam through to a path that's still GitHub-hardcoded.
- Reuse the existing routing pattern (`makeRoutingEpicGateway`/`makeRoutingPollGateway` in `epic-store/index.ts`, `readEpicStoreConfig` for mode) rather than inventing new selectors.
- PRs/reviews are GitHub-native in **both** modes. File mode just can't resolve the PR via `Closes #<n>` — so resolve it via the Epic file's durable `meta.pr` stamp instead.
- Each phase ships with a unit test for the seam **and** an integration test that drives the real path (poller resume / auto-dispatch readState / cache refresh+read), per the integration-verified definition of done.

## Phases
1. **File-mode PR-review resume** — `file-poll-gateway.findPrForEpic`/`findEpicPrLifecycle` resolve a slug's PR via `meta.pr` → `gh.getPullRequest`, so `review-changes`/`CHANGES_REQUESTED`/merged-reconcile resume works in file mode.
2. **File-mode recommender + auto-dispatch** — route auto-dispatch `readState` + recommender state I/O through a routing state gateway (file ⇄ github); bump `state-issue` `InFlightItem.issue` to carry a string ref (slug); source in-flight rows from `epicRef`.
3. **File-mode Epic browse cache + dashboard** — make `epics-cache` ref-keyed (nullable `number`), route `refreshEpics` per mode, add `ref` to the dashboard `EpicCard` wire type, and route dashboard `listEpics` lookups by ref so file Epics surface in `mm status` / the dashboard.

## Files likely to change
- `packages/dispatcher/src/epic-store/file-poll-gateway.ts` — resolve PR by `meta.pr` for slugs (P1)
- `packages/dispatcher/test/epic-store/file-poll-gateway.test.ts` — flip the "returns null for slug" cases (P1)
- `packages/state-issue/src/schema.v1.ts`, `parser.ts`, `validate.ts` + `schemas/state-issue.v1.md` — `InFlightItem.issue` string ref (P2)
- `packages/dispatcher/src/epic-store/index.ts` — add `makeRoutingStateGateway` (P2)
- `packages/dispatcher/src/main.ts` — route auto-dispatch/recommender state gateway + `refreshEpics` per mode (P2, P3)
- `packages/dispatcher/src/workflows/recommender.ts` — source in-flight from `epicRef` (P2)
- `packages/dispatcher/src/epics-cache.ts` + new migration `010_*` — ref-keyed cache (P3)
- `packages/dashboard/src/wire.ts`, `db-deps.ts`, `app/components/Epics.tsx` — `ref` on the card, ref-based lookup (P3)

## Out of scope (already shipped in #190, per issue body)
- File-mode dispatch, question-park, file-watcher question-resume, the parity test, the CLI surface, the skill abstraction — all on merged PR #198.

## Open questions
- None blocking. The `InFlightItem` change is additive (numeric refs are a subset of string refs; render format `**#<ref>**` is unchanged), so it stays schema v1 rather than forcing a v1→v2 bump. Documented in decisions.md.
