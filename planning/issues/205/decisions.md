# Decisions — Issue #205

## Idempotency semantics: skip-on-latest-match, never edit a prior question away
**File(s):** `packages/dispatcher/src/build-deps.ts` (`postQuestionComment`)
**Date:** 2026-06-03

**Decision:** The default `postQuestion` lists the Epic's comments, finds the
*most recent* agent-comment (the `AGENT_COMMENT_MARKER` prefix), and:
- if its body equals the body we'd post → **no-op** (skip the post);
- otherwise → **post a fresh comment** (never edit the prior one).

**Why:** The dispatch brief's Bug B step 4 said to *edit the most recent
agent-comment in place* when the new question differs. But acceptance criterion 1
says a **different** question "creates a new comment but does NOT edit the prior
one (questions are a history)." These conflict. The acceptance criterion is the
mechanical gate and the more sensible behavior (a human reading the thread sees
the full question history, not a single mutated comment), so it wins. The only
collapse is the identical-to-latest repeat — which is exactly the #177 spam.

**Evidence:** Acceptance criterion 1 in the issue body; the upsert-by-marker
precedent `upsertEvidenceComment` (`gates/gate-evidence.ts`) edits in place
because evidence is one-comment-per-phase, whereas questions are a history — so
the semantics deliberately diverge.

## Match the *latest* agent-comment, comparing full rendered body
**File(s):** `packages/dispatcher/src/build-deps.ts`
**Date:** 2026-06-03

**Decision:** Comments arrive chronological (oldest→newest, per `ghGitHub`'s
`gh issue view --json comments`); the last marker-prefixed comment is the most
recent agent-comment. Compare the full `formatPauseComment(...)` body (trimmed),
not just the question text.

**Why:** Comparing the full rendered body folds question + context + kind into
one check — a complexity pause and a plain question with the same text render
differently and are correctly treated as distinct. Comparing only against the
*latest* (not any) agent-comment preserves "questions are a history": re-asking
an older question after a different one posts it again.

## Sentinel cleanup keys off the worktree path, not `outcome.sentinelPath`
**File(s):** `packages/dispatcher/src/workflows/implementation.ts` (`parkForResume`)
**Date:** 2026-06-03

**Decision:** Remove `join(handle.path, ".middle", "blocked.json")` after
consuming the sentinel, deriving the path from the prepare-worktree handle (the
same anchor the drive's own `existsSync` checks use), not from
`outcome.sentinelPath`.

**Why:** In production `outcome.sentinelPath` IS the worktree path, but it's
adapter-reported and the stubs in tests use a fake `/x/.middle/blocked.json`.
Anchoring on `handle.path` is the single stable home of the workstream's sentinel
(matches `classify.ts`'s "worktree root, not payload.cwd" rule) and is what the
drive checks at lines 609/937. Cleanup runs unconditionally for an
`asked-question` park (whether or not the post succeeded) — the `waitFor` is
already durably armed, so removing the file can't strand the resume, and leaving
it is what feeds the next tick's re-post.

## Integration test drives the real park path, not a literal daemon boot
**File(s):** `packages/dispatcher/test/park-question-spam.test.ts`
**Date:** 2026-06-03

**Decision:** The integration test runs the **real** implementation workflow's
park path three times (three dispatch ticks) against a stateful github fake
(comment store) and a fixture worktree whose adapter writes a stale
`blocked.json` on each `installHooks`, using the **real** default `postQuestion`
(via the extracted `makeDefaultPostQuestion` factory) and the **real**
`parkForResume`. It asserts the comment store grows by ≤ 1 across three ticks and
the sentinel is cleaned after each park.

**Why:** Acceptance criterion 3 says "boots the daemon … three recommender
ticks." A literal daemon boot wires real tmux + live `gh` + the recommender cron,
none of which is unit-bootable in this suite (`buildImplementationDeps`
hardcodes real tmux/worktree). The spam seam the fix touches is the workflow's
park → postQuestion path; driving *that* three times through the engine, with a
real worktree + real sentinel file + the real idempotent poster, is the faithful
integration of both fixes. Extracting `makeDefaultPostQuestion` keeps the
production path and the test path byte-identical (no re-implemented poster).
