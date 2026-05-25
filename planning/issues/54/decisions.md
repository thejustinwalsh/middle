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
