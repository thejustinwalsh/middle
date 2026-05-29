# Issue #178: mark agent-posted pause comments so the poller doesn't self-resume

**Link:** https://github.com/thejustinwalsh/middle/issues/178
**Branch:** middle-issue-178

## Goal
Stop the GitHub poller from treating the dispatcher's own pause comment (posted under the dispatcher's human `gh` identity) as "the human reply," which fires a spurious `RESUME_EVENT` and burns a continuation run fed the agent's own question as its answer.

## Approach
- Reuse the established HTML-comment-marker convention (`<!-- AGENT-QUEUE-STATE v1 -->` in state-issue, `<!-- middle:gate-evidence:phase-N -->` in the gate flow).
- Define one stable, hidden marker constant — `AGENT_COMMENT_MARKER = "<!-- middle:agent-comment -->"` — in `poller.ts` (the classifier's home, already the leaf that exports `CI_FAILED_DECISION` consumed elsewhere; no import cycle since `build-deps.ts` already transitively depends on `poller.ts`).
- `formatPauseComment` (build-deps.ts) prepends the marker so every pause comment **starts with** it; the visible `🙋` / `🧩` prefixes stay intact below it.
- `classifyNewHumanReply` (poller.ts) skips any comment whose body contains the marker, regardless of author — structural self-discrimination, no bot account needed.

## Phases
1. Marker + skip + format — add the constant, prepend it in `formatPauseComment`, filter it in `classifyNewHumanReply`, with tests for each acceptance criterion (including the end-to-end post-a-question → run-poller → no-spurious-resume case).

## Files likely to change
- `packages/dispatcher/src/poller.ts` — define `AGENT_COMMENT_MARKER`; filter it in `classifyNewHumanReply`.
- `packages/dispatcher/src/build-deps.ts` — prepend the marker in `formatPauseComment`.
- `packages/dispatcher/test/poller.test.ts` — classifier skips marked comments; end-to-end no-spurious-resume.
- `packages/dispatcher/test/build-deps.test.ts` — `formatPauseComment` output starts with the marker, both kinds, visible prefixes preserved.

## Out of scope
- Switching to a bot `gh` identity (the marker keeps the existing gh-identity model).
- Marking other dispatcher-posted comments (gate-failure nudges, checkbox reverts) — they aren't classified by `classifyNewHumanReply`.

## Open questions
- None — the issue specifies the marker pattern and acceptance criteria precisely.
