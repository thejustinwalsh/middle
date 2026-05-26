# Decisions — Issue #148

## Two prompt modes selected by `config.write`, not a separate flag
**File(s):** `packages/dispatcher/src/workflows/documentation.ts`
**Date:** 2026-05-26

**Decision:** `assembleDocumentationPrompt` branches on `config.write`: `false` → the
existing read-only `mode: audit` prompt; `true` → a `mode: write` prompt that tells the
agent to discover-or-author (maintain an existing surface, author the initial corpus when
none exists) and write files to disk for the dispatcher to commit.
**Why:** `config.write` is already the single gate the spec/config defines for "the bot
audits/dry-runs vs writes." Adding a second axis (a separate mode field) would let the two
drift out of sync. One gate, two prompts.
**Evidence:** `DocsSettings.write` doc — "When false (default), the bot audits/dry-runs only
and writes nothing." Issue #148 AC: write mode authors; discover-or-author.

## Persist decomposed: real local commit + injected push/PR
**File(s):** `packages/dispatcher/src/docs-persist.ts`
**Date:** 2026-05-26

**Decision:** `persistDocs` is split into `commitDocs` (stage + commit the worktree, real
local git, returns null when nothing changed) and `ghPushAndOpenPr` (push the branch + open
a **draft** PR via `gh`). `makeGhPersistDocs(push)` composes them; the push step is the
injected seam.
**Why:** The commit path is the part criterion 4 wants exercised by a real test against a
fixture repo; pushing to a live GitHub remote is genuinely external and can't run in a test.
Decomposing lets the integration test run the real authoring+commit path and stub only the
push. An empty commit/PR is avoided by the null-return when `git status` is clean.
**Evidence:** Issue #148 AC3 ("commit/push or PR … no longer a no-op stub"), AC "Out of
scope: auto-merging the docs PR (human merges)" → draft PR.
