# Issue #148: Docs harvester — author markdown into `docs/` when no surface exists (wire the persist seam)

**Link:** https://github.com/thejustinwalsh/middle/issues/148
**Branch:** middle-issue-148

## Goal
Turn the docs harvester from audit-only into discover-or-author: in write mode it
authors Diátaxis markdown into the resolved markdown target (`docs/`) when no
surface exists, maintains an existing surface when one does, and the `persistDocs`
seam — currently a no-op stub left UNWIRED by the runner — actually commits the
authored docs and opens a draft PR. `config.write` gates writing throughout.

## Approach
- The "where" is already correct (`resolveDocsTarget` → markdown fallback at `docs/`).
  The missing half is the **author + persist** path. Two seams change:
  1. The **prompt** gains a `write` mode (discover-or-author + maintain) distinct
     from the existing read-only `audit` mode. `config.write` selects which.
  2. The **persist seam** is wired: a real `persistDocs` that stages the authored
     docs, commits them, pushes the branch, and opens a **draft** PR (human merges,
     per spec). Decomposed so the local commit path is unit-testable and only the
     push/PR step is the external (injected) seam.
- Wire `dispatchDocumentation` to pass the real `persistDocs` (no longer UNWIRED);
  the workflow's `if (!config.write || !persistDocs) return` gate stays the writer.
- Integration test exercises the **real authoring path**: a fixture repo with no
  `docs/`, a stubbed agent that authors markdown into the worktree, the real commit
  path persisting it, and the push/PR seam capturing what was committed.

## Phases
1. **Write-mode prompt** — `assembleDocumentationPrompt` emits `mode: write` with
   discover-or-author + maintain instructions when `config.write` is true; keeps
   `mode: audit` (read-only) when false. Update `DocumentationRunConfig` docs.
2. **Wire the persist seam** — new `docs-persist.ts`: `commitDocs` (local git,
   real) + `ghPushAndOpenPr` (external) + `makeGhPersistDocs` composing them.
   Wire it into `dispatchDocumentation` (write-gated); update workflow/runner docs
   and the "read-only first" tests that asserted the seam was unwired.
3. **Integration verification** — a test runs the harvester against a fixture repo
   with NO docs surface, the stub agent authors markdown under `docs/`, and asserts
   the files are written and persisted (committed + push/PR seam invoked).

## Files likely to change
- `packages/dispatcher/src/workflows/documentation.ts` — write-mode prompt, comments
- `packages/dispatcher/src/docs-persist.ts` — **new**: commit + push/PR persist seam
- `packages/dispatcher/src/documentation-run.ts` — wire `persistDocs`, override seam
- `packages/cli/src/commands/docs.ts` — update read-only wording
- `packages/dispatcher/test/documentation-workflow.test.ts` — write-mode prompt tests
- `packages/dispatcher/test/documentation-run.test.ts` — wired-persist + integration test
- `packages/dispatcher/test/docs-persist.test.ts` — **new**: commit-path unit tests

## Out of scope
- Standing up a full docs-site framework (Starlight/Docusaurus) — markdown fallback only.
- Auto-merging the docs PR (human merges, per spec) — the seam opens a **draft** PR.

## Open questions
- None blocking. "Persisted" is interpreted as committed-to-branch + push/PR seam
  invoked; pushing to a live GitHub remote is the genuinely-external step and is the
  injected seam (stubbed in tests, `gh`-backed in production).
