# Decisions — Issue #54 (Dashboard)

## Self-contained dashboard server with injectable seams
**File(s):** `packages/dashboard/src/server.ts`, `deps.ts`
**Date:** 2026-05-25

**Decision:** The dashboard is its own `Bun.serve()` server with a `createDashboardFetch(deps)` handler; all live data arrives through an injectable `DashboardDeps` seam (db queries, state-issue reader, tmux attach spawner, recommender trigger, config store).
**Why:** Mirrors the dispatcher's `ControlPlane` seam pattern (`hook-server.ts`) — every route unit-tests without a daemon, a real db, or GitHub. The alternative (mounting routes directly into the dispatcher's hook-server) is not asked for by any sub-issue and would couple the SPA to live infra; deferred as a one-line composition later.
**Evidence:** `packages/dispatcher/src/hook-server.ts` `ControlPlane`; `event-hub.ts` header note that the hub exists "so the dashboard's per-repo/session views (#57) can reuse it."

## webview-bun is an optionalDependency, lazy-spawned in a separate process
**File(s):** `packages/dashboard/src/window.ts`, `packages/cli/src/commands/start.ts`
**Date:** 2026-05-25

**Decision:** `--window` spawns `bun <dashboard>/window.ts <url>` detached; that process is the only thing that imports `webview-bun`. The dep is declared `optional`.
**Why:** webview-bun is a native module; the headless test gate has no display and may not build it. An optionalDependency never fails `bun install`, and lazy-spawning keeps it off the default path and out of every test — satisfying "without --window, no webview dependency loaded."
**Evidence:** spec → "Optional windowed mode" ("Adds ~50 lines. Defaults off"); existing `start.ts` already gates the window step behind `--window`/`[dashboard] windowed`.

## DOM libs added to the root tsconfig
**File(s):** `tsconfig.json`
**Date:** 2026-05-25

**Decision:** Added `DOM` + `DOM.Iterable` to the root `lib`.
**Why:** Typecheck is a single root `tsc --noEmit` program (no project references), so a per-package `lib` override is ignored by the gate. The dashboard is the repo's first browser code (React 19), which needs DOM globals. Adding DOM ambiently is the lowest-friction option; the alternative (project references + `tsc -b`) reworks the build for one package. Verified the full typecheck stays green — server packages gain ambient browser types but no errors.
**Evidence:** `bun run typecheck` clean across all packages after the change.

## controlledBy added to the dispatcher's WorkflowPatch
**File(s):** `packages/dispatcher/src/workflow-record.ts`
**Date:** 2026-05-25

**Decision:** Extended `WorkflowPatch` + `PATCH_COLUMNS` with `controlledBy`.
**Why:** Take control / Release is a first-class workflow mutation the spec calls out, and the watchdog already reads `controlled_by` to skip freshness checks for human-driven sessions. Reusing the one shared mutator (it fires the broadcast observer) beats a second raw writer in the dashboard.
**Evidence:** spec → "human takeover"; `dispatcher/CLAUDE.md` (watchdog skips freshness while `controlled_by = 'human'`).

## Channel-keyed SSE bus over the dispatcher's EventHub
**File(s):** `packages/dashboard/src/events.ts`
**Date:** 2026-05-25

**Decision:** One `EventHub` per channel key (`global`, `repo:<repo>`, `session:<session>`), created lazily and swept when drained.
**Why:** The dispatcher's `EventHub` fans every event to every subscriber with no server-side filter; the spec needs three filtered channels. A hub-per-channel gives per-channel isolation for free while reusing the hub's tested subscriber/heartbeat machinery. Pruning empty hubs on `serve` bounds the map.
**Evidence:** `event-hub.ts` header ("the dashboard's per-repo/session views can reuse it"); review pass flagged unbounded map growth → added the sweep.

## Settings global-config edits mutate the in-memory merged config (v1)
**File(s):** `packages/dashboard/src/db-deps.ts` (`updateGlobalConfig`)
**Date:** 2026-05-25

**Decision:** `updateGlobalConfig` mutates the live merged `MiddleConfig` the server holds; `getSettings` reflects it. Durable file persistence is deferred.
**Why:** The config loader/merge mechanics are Phase 1's domain (and #58's "Out of scope" lists "Config loader/merge mechanics"). The acceptance criterion is a round-trip through the API, which the in-memory model satisfies; writing TOML back is a separate, larger concern.
**Evidence:** #58 body "Out of scope: Config loader/merge mechanics (Phase 1)".
