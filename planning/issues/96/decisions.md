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
