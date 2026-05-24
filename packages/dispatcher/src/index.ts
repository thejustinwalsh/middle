/**
 * @packageDocumentation
 * @module @middle/dispatcher
 *
 * The long-running dispatcher: the per-Epic dispatch, the GitHub poller, the
 * watchdog, SQLite-backed workflow records, and the hook receiver. The runnable
 * process is `main.ts` (the package `main`, spawned by `mm start`); this index
 * is the documented API surface.
 *
 * Public surface:
 * - `buildImplementationDeps` — assemble the implementation workflow's deps +
 *   PR-ready gate (the daemon and any host share this wiring)
 * - `EventHub` (+ `Event`) — the control plane's SSE broadcast hub
 * - `HookServer` (+ `SessionGate`, `ControlPlane`, `ControlDispatchInput`) — the
 *   hook receiver + `/control` + `/health` surface
 * - `startPoller` / `POLLER_INTERVAL_MS`, `startWatchdog` / `WATCHDOG_INTERVAL_MS`
 *   — the reconciliation crons
 * - `openDb` / `openAndMigrate` / `MIGRATIONS_DIR` — the dispatcher database
 * - `WorkflowRecord` / `WorkflowState` — workflow persistence types
 *
 * Where things live:
 * - `main.ts` — the process entry (`mm start` spawns it); the daemon owns the
 *   one long-lived engine that hosts every dispatch + review-resume
 * - `build-deps.ts` — the shared implementation-workflow deps + gate factory
 * - `event-hub.ts` — the SSE broadcast hub the control plane serves
 * - `hook-server.ts`, `hook-store.ts` — receive + persist hooks; `/control` + `/health`
 * - `poller*.ts` / `watchdog*.ts` — the GitHub-poll + liveness crons
 * - `db.ts`, `db/` — SQLite open/migrate + migrations
 * - `tmux.ts`, `worktree.ts` — session + worktree lifecycle
 * - `state-issue.ts` — the dispatcher's edits to the state issue
 *
 * Gotchas:
 * - bunqueue lock-token / lifecycle-race handling, the daemon's single-engine
 *   ownership, and the hybrid SSE broadcast source live here; see this package's
 *   CLAUDE.md.
 *
 * claude-md: true
 */
export { buildImplementationDeps } from "./build-deps.ts";
export { EventHub } from "./event-hub.ts";
export type { Event, WorkflowEventData } from "./event-hub.ts";
export { POLLER_INTERVAL_MS, startPoller } from "./poller-cron.ts";
export { startWatchdog, WATCHDOG_INTERVAL_MS } from "./watchdog-cron.ts";
export { MIGRATIONS_DIR, openAndMigrate, openDb } from "./db.ts";
export { HookServer } from "./hook-server.ts";
export type { ControlDispatchInput, ControlPlane, SessionGate } from "./hook-server.ts";
export type { WorkflowRecord, WorkflowState } from "./workflow-record.ts";
