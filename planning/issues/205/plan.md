# Issue #205: postQuestion idempotency + stale blocked.json cleanup (the 1137-comment spam)

**Link:** https://github.com/thejustinwalsh/middle/issues/205
**Branch:** middle-issue-205

## Goal
Stop the dispatcher from re-posting an agent's question on every cron tick. Two
coupled fixes: make the pause-comment poster idempotent, and clean up the
consumed `blocked.json` sentinel so a re-dispatch / watchdog rule-4 pass doesn't
treat it as fresh.

## Approach
- **Bug B (the spam multiplier) — make `postQuestion` idempotent.** The default
  github-mode poster lists the Epic's comments, finds the most recent
  agent-comment (`AGENT_COMMENT_MARKER` prefix), and *skips* the post when its
  body already equals the comment we'd post. A *different* question still posts a
  fresh comment (questions are a history; we never edit the prior one away).
  Mirror the same dedup-on-latest in the file-mode `appendQuestion` path.
- **Bug A — clean up the sentinel after consumption.** Once `parkForResume` has
  surfaced the question (posted it / appended to the file-mode block), remove
  `<worktree>/.middle/blocked.json`. The durable `waitFor` is already armed, so
  nothing is lost; the watchdog rule-4 re-arm then only fires on *new* sentinels.
- Reuse the existing upsert-by-marker precedent (`upsertEvidenceComment`) shape,
  but with skip-on-identical / post-new-on-different semantics (not edit-in-place,
  per the acceptance criteria's "questions are a history").

## Phases
1. **Bug B — idempotent `postQuestion`** — extract a `postQuestionComment` helper
   (skip-on-latest-match), wire it into the default github poster, add file-mode
   dedup in `appendQuestion`; unit tests for each.
2. **Bug A — sentinel cleanup** — `parkForResume` removes the worktree
   `blocked.json` after consuming it; unit test.
3. **Integration** — drive the real park path across three consecutive dispatch
   ticks against a stateful github fake + a fixture worktree with a stale
   sentinel; assert the comment count grows by ≤ 1, and the sentinel is cleaned.

## Files likely to change
- `packages/dispatcher/src/build-deps.ts` — `postQuestionComment` helper +
  `makeDefaultPostQuestion` factory; default poster becomes idempotent.
- `packages/dispatcher/src/workflows/implementation.ts` — `parkForResume` removes
  the consumed sentinel.
- `packages/dispatcher/src/epic-store/index.ts` — `appendQuestion` dedup-on-latest.
- `packages/dispatcher/test/build-deps.test.ts` — idempotency unit tests; fakes
  gain `listIssueComments`.
- `packages/dispatcher/test/implementation-workflow.test.ts` — sentinel-cleanup
  test.
- `packages/dispatcher/test/epic-store/*` — file-mode dedup test.
- New: `packages/dispatcher/test/park-question-spam.test.ts` — the integration test.

## Out of scope
- Deleting #177's existing 1137 comments (manual operator step).
- Refactoring the agent-question marker (#184 shipped it).
- The recommender's separate decision to keep re-dispatching #177.

## Open questions
- The dispatch brief's Bug B step 4 says "edit the most recent agent-comment in
  place" for a *different* question, but acceptance criterion 1 says a different
  question "creates a new comment but does NOT edit the prior one (questions are
  a history)." These conflict; the **acceptance criterion wins** — different
  question ⇒ new comment, identical-to-latest ⇒ skip. Noted in decisions.md.
