# Decisions — Issue #42 (Phase 7 recommender)

## Recommender launch reuses the adapter via a new `recommender` prompt kind
**File(s):** `packages/core/src/adapter.ts`, `packages/adapters/claude/src/prompt.ts`
**Date:** 2026-05-24

**Decision:** Extend `AgentAdapter.buildPromptText`'s `kind` union with `"recommender"`
(and make `epicNumber` optional, since the recommender has no Epic). The claude adapter
emits `/recommending-github-issues @<promptFile>` — the slash command force-invokes the
recommender skill and the `@`-reference pulls in the assembled context the build-prompt
step wrote to `.middle/prompt.md`.

**Why:** The spec calls `spawn-recommender-agent` "an interactive launch like any other".
CLI-specific prompt syntax belongs in the adapter (same place `/implementing-github-issues`
lives), not hard-coded in the dispatcher workflow — that keeps the recommender adapter-agnostic
like the implementation workflow. `send-keys` can't carry multi-line text, so the context goes
to `.middle/prompt.md` and the launch references it (the established `@`-reference pattern used
by `resume`/`answer`).
**Alternatives considered:** Hard-coding the slash command in the workflow (couples the
dispatcher to claude syntax); a separate `buildRecommenderPrompt` adapter method (more surface
than reusing the existing seam).

## Dedicated slot = `kind:"recommender"` excluded from implementation slot accounting
**File(s):** `packages/dispatcher/src/workflows/recommender.ts`
**Date:** 2026-05-24

**Decision:** The recommender records its `workflows` row with `kind:"recommender"` (already
in the schema). Slot accounting counts only non-terminal `kind:"implementation"` rows, so the
recommender's own run never counts against `maxConcurrent` — it is its own dedicated slot.

**Why:** The spec says "Recommender uses its own dedicated slot (not counted against
`maxConcurrent`)." There is no live concurrency gate yet (Phase 8), so the testable, faithful
manifestation is the slot-accounting exclusion that `build-prompt`'s injected `slots` already
needs (#44). One mechanism serves both #43's dedicated-slot assertion and #44's slot injection.
