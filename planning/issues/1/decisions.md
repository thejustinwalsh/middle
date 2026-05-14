# Decisions — Issue #1

## Scaffold at package granularity, not every leaf file
**File(s):** `packages/*/src/index.ts`
**Date:** 2026-05-14

**Decision:** Each package gets `package.json` + `tsconfig.json` + a single `src/` entry stub. The individual leaf files named in the spec's Repo layout (`watchdog.ts`, `classify.ts`, `routes/`, etc.) are NOT created as empty stubs.
**Why:** Issue #2's acceptance criterion lists *package directories* to scaffold, and its Out-of-scope says "implementing any package's source". Empty leaf stubs are structure without implementation — noise that later phases own. Package-level scaffold is the correct granularity for Phase 0.
**Evidence:** Issue #2 acceptance criteria + Out of scope; spec "Repo layout".

## Bun upgraded 1.3.5 → 1.3.14
**Date:** 2026-05-14

**Decision:** Ran `bun upgrade` to satisfy the spec's "Bun ≥1.3.12" stack requirement.
**Why:** The environment shipped Bun 1.3.5; issue #2 acceptance pins the stack at Bun ≥1.3.12.
**Evidence:** Spec "Tech stack"; issue #2 acceptance criteria.

## typecheck via `tsc --noEmit`, not `tsc --build`
**File(s):** `package.json`
**Date:** 2026-05-14

**Decision:** Root `typecheck` script is `tsc --noEmit`.
**Why:** `tsc --build` requires TS project references (`composite: true` per package + `references` in root). That's machinery Phase 0 doesn't need — a flat `--noEmit` check over the workspace is sufficient and simpler. Project references can be added later if build performance demands it.
**Evidence:** No spec requirement for `tsc --build`; `bun` runs TS natively so `tsc` is type-checking only.
