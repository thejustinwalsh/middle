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
 * - `dispatchEpic` (+ `DispatchEpicOptions`, `DispatchEpicResult`) — run an Epic
 *   through the implementation workflow
 * - `startPoller` / `POLLER_INTERVAL_MS`, `startWatchdog` / `WATCHDOG_INTERVAL_MS`
 *   — the reconciliation crons
 * - `openDb` / `openAndMigrate` / `MIGRATIONS_DIR` — the dispatcher database
 * - `HookServer` (+ `SessionGate`) — the hook receiver
 * - `WorkflowRecord` / `WorkflowState` — workflow persistence types
 *
 * Where things live:
 * - `main.ts` — the process entry (`mm start` spawns it)
 * - `dispatch.ts` — the per-Epic dispatch + bunqueue workflow wiring
 * - `poller*.ts` / `watchdog*.ts` — the GitHub-poll + liveness crons
 * - `db.ts`, `db/` — SQLite open/migrate + migrations
 * - `hook-server.ts`, `hook-store.ts` — receive + persist agent hook events
 * - `tmux.ts`, `worktree.ts` — session + worktree lifecycle
 * - `state-issue.ts` — the dispatcher's edits to the state issue
 *
 * Gotchas:
 * - bunqueue lock-token / lifecycle-race handling and the watchdog's reconcile
 *   timing live here; see this package's CLAUDE.md.
 *
 * claude-md: false
 */
export { dispatchEpic } from "./dispatch.ts";
export type { DispatchEpicOptions, DispatchEpicResult } from "./dispatch.ts";
export { POLLER_INTERVAL_MS, startPoller } from "./poller-cron.ts";
export { startWatchdog, WATCHDOG_INTERVAL_MS } from "./watchdog-cron.ts";
export { MIGRATIONS_DIR, openAndMigrate, openDb } from "./db.ts";
export { HookServer } from "./hook-server.ts";
export type { SessionGate } from "./hook-server.ts";
export type { WorkflowRecord, WorkflowState } from "./workflow-record.ts";
