# Decisions — Issue #178

## Marker lives in `poller.ts`, imported by `build-deps.ts`
**File(s):** `packages/dispatcher/src/poller.ts`, `packages/dispatcher/src/build-deps.ts`
**Date:** 2026-05-29

**Decision:** Define `AGENT_COMMENT_MARKER` as an exported constant in `poller.ts` and import it into `build-deps.ts`.
**Why:** `poller.ts` is the classifier's home and is already the leaf module that exports a poller-vocabulary constant consumed elsewhere (`CI_FAILED_DECISION`, imported by `workflows/implementation.ts`). `build-deps.ts` already transitively depends on `poller.ts` (`build-deps` → `workflows/implementation` → `poller`), so a direct `build-deps` → `poller` import adds no cycle. A new shared `constants.ts` would be over-engineering for one string.
**Evidence:** `packages/dispatcher/src/workflows/implementation.ts:9` imports `CI_FAILED_DECISION` from `../poller.ts`.

## Classifier matches `startsWith`, not `includes`
**File(s):** `packages/dispatcher/src/poller.ts` (`classifyNewHumanReply`)
**Date:** 2026-05-29

**Decision:** `classifyNewHumanReply` skips a comment iff its body **starts with** the marker, not merely contains it.
**Why:** The dispatcher always emits the marker at byte 0 (acceptance criterion #1: "output starts with a stable, hidden marker"), so `startsWith` precisely identifies the dispatcher's own comments. `includes` would additionally drop a *genuine human reply* that quote-replies the pause comment — GitHub's "Quote reply" copies the raw markdown (HTML comment included) into the new comment, so the human's real answer would contain the marker mid-body and be silently skipped, hanging the resume forever. `startsWith` pairs symmetrically with the "starts with" format contract and strictly dominates `includes`: it skips every dispatcher comment (all marker-prefixed) while never dropping a foreign comment that merely embeds the marker.
**Evidence:** AC #1 mandates the marker is at the start; the issue's "skips any comment containing" wording is satisfied in intent (skip the dispatcher's own comments) while avoiding the quote-reply false-skip. Regression test: a human reply with the marker on a quoted (non-leading) line still resumes.
