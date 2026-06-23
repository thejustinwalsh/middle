# Issue #254: fix(implementation): review-round-cap park posts no escalation comment and arms no signal

**Link:** https://github.com/thejustinwalsh/middle/issues/254
**Branch:** fix/round-cap-escalation

## Goal

When the review-round cap is hit, post a GitHub comment on the Epic naming the cap and recording a `workflow.round-cap` event — so the stall is observable on GitHub instead of silent.

## Approach

- Mirror the `asked-question` park pattern: add `postRoundCapEscalation` optional dep to `ImplementationDeps`, called in the round-cap branch alongside `recordEvent("workflow.round-cap", ...)`.
- Add `formatRoundCapComment` to `build-deps.ts` alongside `formatPauseComment` (reuses `AGENT_COMMENT_MARKER` so the poller skips the comment).
- Wire `makeDefaultPostRoundCapEscalation` into `buildImplementationDeps` the same way `postQuestion` is wired (injectable for tests).
- Unit tests: one for comment content (via `postRoundCapEscalation` spy), one for event row (`getEventsByType`).
- Integration test: drive a real round-cap park in `implementation-workflow.test.ts` using the existing `withContinuations` harness; assert the comment was dispatched and the `workflow.round-cap` event row was written.

## Phases

1. **Unit tests (failing)** — write tests asserting `postRoundCapEscalation` is called with correct args and `workflow.round-cap` event exists (these fail before the fix).
2. **Fix** — add `postRoundCapEscalation` dep and `recordEvent` call in the round-cap branch; add `formatRoundCapComment` + `makeDefaultPostRoundCapEscalation` in `build-deps.ts`; wire into `buildImplementationDeps`.
3. **Integration test** — drive the full round-cap park through the real workflow, asserting both comment and event.
4. **Lint / typecheck / full test suite green.**

## Files likely to change

- `packages/dispatcher/src/workflows/implementation.ts` — add dep + call in round-cap branch
- `packages/dispatcher/src/build-deps.ts` — add `formatRoundCapComment`, `makeDefaultPostRoundCapEscalation`, wire dep
- `packages/dispatcher/test/implementation-workflow.test.ts` — unit + integration tests

## Out of scope

- Arming a distinct `waitfor_signals` row (optional enhancement per issue).
- Making the round cap configurable.

## Open questions

None — the issue is precise and complete.
