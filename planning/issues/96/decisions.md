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
