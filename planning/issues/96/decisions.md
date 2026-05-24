# Decisions — Issue #96 (Docs harvester)

## `[docs]` config is a single dual-purpose section
**File(s):** `packages/core/src/config.ts`
**Date:** 2026-05-24

**Decision:** One `[docs]` TOML section carries both the resolver override (`tool`, `path`) from #97 and the bot settings (`enabled`, `interval_minutes`, `adapter`, `write`) from #98.
**Why:** #97 and #98 are two halves of one feature on one config surface. Splitting into `[docs]` + `[docs_bot]` would force users to repeat the docs root and would not match the recommender's single `[recommender]` block. The override fields and bot fields never conflict.
**Evidence:** Mirrors `[recommender]` in the same file; the Epic frames the resolver and bot as siblings sharing the docs surface.

## `mapDocs` defaults the bot fields instead of trusting presence
**File(s):** `packages/core/src/config.ts`
**Date:** 2026-05-24

**Decision:** Unlike `mapRecommender`/`mapLimits` (which cast `raw.x as T` and trust the key is present), `mapDocs` defaults `enabled→false`, `interval_minutes→60`, `adapter→"claude"`, `write→false`, and leaves `tool`/`path` undefined when absent.
**Why:** The resolver use case is a `[docs]` block that sets *only* `tool`/`path` to force a target, with no intent to enable the bot. Strict casts would yield `enabled: undefined as boolean`. Override fields must stay `undefined` so the resolver can tell "auto-detect" from "forced". `write` defaults false so the bot is read-only unless explicitly opted in — parity with the recommender's deliberately-unwired write path.
**Evidence:** Test `a tool/path-only override block is valid; bot fields default` in `packages/core/test/config.test.ts`.

## Resolver is its own package `@middle/docs`, not part of `@middle/core`
**File(s):** `packages/docs/**`
**Date:** 2026-05-24

**Decision:** The target resolver lives in a new `@middle/docs` package, parallel to how `AgentAdapter` implementations live in `packages/adapters/*` rather than inside core.
**Why:** The resolver is a cohesive subsystem with fixture-based tests and one detector file per framework — substantial enough to warrant a boundary, and core is meant to stay lean (shared types + config loader). The `DocsSettings` *type* stays in core (config schema); the resolver *imports* it. No cycle: docs → core only.
**Evidence:** `packages/adapters/claude` and `packages/adapters/codex` are the precedent — adapter implementations are siblings of core, not core itself.

## Detection resolves a single primary target by documented priority
**File(s):** `packages/docs/src/resolve.ts`
**Date:** 2026-05-24

**Decision:** When multiple frameworks co-reside, resolve one primary target by priority: Starlight > Docusaurus > MkDocs > TypeDoc > markdown. The override forces exactly one.
**Why:** `three-flatland` (the reference stack) is Starlight + `starlight-typedoc` — TypeDoc API output nests *inside* the Starlight host, it is not a competing top-level surface. A prose host therefore wins; TypeDoc is selected only when it stands alone. A single primary target also matches the adapter-shaped contract (one resolved target, like one selected adapter). True multi-target fan-out, if ever needed, is a follow-up.
**Evidence:** Test `Starlight wins over co-resident TypeDoc` against the `starlight-typedoc` fixture.

## An unknown `tool` override throws rather than falling back
**File(s):** `packages/docs/src/resolve.ts`
**Date:** 2026-05-24

**Decision:** `resolveDocsTarget` throws on an unrecognized `[docs] tool`, listing the valid names, instead of silently falling back to markdown.
**Why:** A typo'd `tool` is a config error the user must see. Silently routing to markdown would publish docs to the wrong place and look like a detection miss. Detection itself is total (always yields a target); only the *explicit forced override* validates strictly.
**Evidence:** Test `an unknown tool override throws with the valid names`.

## MkDocs `docs_dir` / TypeDoc `out` read without a YAML/JS parser
**File(s):** `packages/docs/src/detectors/mkdocs.ts`, `typedoc.ts`
**Date:** 2026-05-24

**Decision:** MkDocs `docs_dir` is read with a line-anchored regex; TypeDoc `out` is read from `typedoc.json` via `JSON.parse` (or the `typedoc.out` package.json key). No YAML or JS-config evaluator is pulled in.
**Why:** Adding a YAML dependency (or evaluating a JS/TS config) for a single scalar is disproportionate and, for JS configs, unsafe (arbitrary code). The regex/JSON read covers the conventional cases; an exotic `docs_dir` falls back to the default `docs`, and the config override is the escape hatch.
**Evidence:** Tests `detects MkDocs and reads a custom docs_dir` and `detects TypeDoc from typedoc.json and reads out`.

## Docs bot mirrors the recommender; the skill authors, the workflow orchestrates
**File(s):** `packages/dispatcher/src/workflows/documentation.ts`, `documentation-run.ts`
**Date:** 2026-05-24

**Decision:** The `documentation` workflow is a near-exact structural mirror of the `recommender` workflow (check-rate-limit → prepare-worktree → build-prompt → spawn-agent → persist-docs → cleanup), and delegates all authoring/audit to the `documenting-the-repo` skill via the `docs` prompt kind. The workflow never reimplements the audit logic.
**Why:** The Epic frames the docs bot as the recommender's sibling throughout. Mirroring the proven structure (dedicated slot off `maxConcurrent`, 5-min hard cap, compensation on prepare, one-shot turn) gets correctness for free and keeps the two siblings maintainable in lockstep. The skill is the single source of voice + audit rules (#95); duplicating them in code would drift.
**Evidence:** `documentation-workflow.test.ts` asserts step-order/slot/cap parity with `recommender-workflow.test.ts`.

## Read-only/dry-run first: `persistDocs` is the gated, unwired write seam
**File(s):** `packages/dispatcher/src/workflows/documentation.ts` (`persist-docs` step), `documentation-run.ts`
**Date:** 2026-05-24

**Decision:** The run is always an **audit** pass; the agent reports drift and does not persist. The `persist-docs` step is the write seam, gated on `config.docs.write` AND an injected `persistDocs` dep — and the runner leaves `persistDocs` UNWIRED, exactly as the recommender leaves `triggerAutoDispatch` unwired. So even with `write=true`, nothing is committed/PR'd in this Epic.
**Why:** #98's acceptance is explicit: "Read-only / dry-run first (like the recommender's first phase) before it writes." The recommender's first phase (#42) shipped read-only with its write/dispatch seam unwired; the docs bot is to mirror that. Persisting generated docs (commit/push/PR) is the genuinely outward-facing action and is the next increment — present in the types and the step, wired later.
**Evidence:** Tests `write=true but persistDocs UNWIRED: still persists nothing` and `dispatchDocumentation … persists nothing … even with write=true`.

## The docs bot claims its own worktree unit ("docs")
**File(s):** `packages/dispatcher/src/worktree.ts` (`unit` override), `workflows/documentation.ts`
**Date:** 2026-05-24

**Decision:** Added an optional `unit` override to `CreateWorktreeOpts`; the docs bot passes `"docs"`. Without it, an issue-less workflow defaults to the `"recommender"` unit and would collide with a concurrent recommender run's worktree/branch.
**Why:** Worktree dir + default branch are keyed by unit (`<repo>/<unit>`, `middle-<unit>`). Two distinct repo-level bots must not share a unit. The override is the minimal, general change (any future non-issue workflow can claim its own unit).
**Evidence:** Test `claims the 'docs' worktree unit, distinct from the recommender's`.

## Schema-rebuild migrations: FK enforcement toggled by the runner, not the migration
**File(s):** `packages/dispatcher/src/db.ts` (`runMigrations`), `db/migrations/003_documentation_workflow_kind.sql`
**Date:** 2026-05-24

**Decision:** `runMigrations` disables `PRAGMA foreign_keys` around the pending-migration loop and runs `PRAGMA foreign_key_check` inside each migration's transaction. Migration 003 rebuilds `workflows` with the create-new → copy → **drop-old** → rename recipe.
**Why:** SQLite can't alter a CHECK in place. A naive rename-old-then-drop rewrites child FK targets to the renamed `_old` table and the subsequent DROP cascade-deletes child rows (verified empirically — `legacy_alter_table` did not prevent the rewrite in Bun's SQLite). The documented fix needs FK enforcement off, which is a no-op inside a transaction — so the toggle must live in the runner, wrapping the loop. The per-migration `foreign_key_check` is the safety net that still catches a migration that leaves a dangling reference.
**Evidence:** Tests `003 widens workflows.kind …` and `003 preserves existing rows and child FK references through the table rebuild` in `db.test.ts`.

## `mm docs <repo>` on-demand path; cadence config present, live cron deferred (recommender parity)
**File(s):** `packages/cli/src/commands/docs.ts`, `packages/cli/src/index.ts`, `packages/cli/src/bootstrap/config-template.ts`
**Date:** 2026-05-24

**Decision:** Ship the on-demand path fully (`mm docs <repo>`, the recommender's `mm run-recommender` analog) and stamp a `[docs]` block (with `interval_minutes`) into the per-repo config. A *live* cron is NOT wired.
**Why:** #98's acceptance is "Runs on a cadence (cron, like the recommender) **and/or** on demand." The recommender itself has no live cron yet — its cron is explicitly deferred to "Phase 2+" (see `dispatcher/src/main.ts`), and it ships as CLI- + dashboard-triggered. Matching that exact bar: on-demand delivered, the cadence interval lives in config as the seam a future cron reads. Holding the docs bot to a higher bar than its sibling would be inconsistent.
**Evidence:** `packages/cli/test/docs.test.ts` (validation, target resolution, override flow-through, exit codes); `mm --help` lists `docs`.
