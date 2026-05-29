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
 * - `runDaemon` (+ `RunDaemonOptions`, `DaemonHostContext`) — start the
 *   long-running daemon; `hostExtras` injects the dashboard's routes/disposer;
 *   `DaemonHostContext` carries `dispatch` + `refreshEpics` for the dashboard
 * - `buildImplementationDeps` — assemble the implementation workflow's deps +
 *   PR-ready gate (the daemon and any host share this wiring)
 * - `autoDispatch` (+ `AutoDispatchDeps`, `AutoDispatchResult`) — the
 *   slot-and-rate-limit-aware loop that enqueues ready Epics
 * - `getSlotState` / `hasFreeSlot` / `reserveSlot` (+ `SlotState`, `SlotLimits`,
 *   `SlotDimension`) — the concurrency-slot authority the enqueue paths consult
 * - `setPausedUntil` / `clearPaused` / `isPaused` / `getPausedUntil` — the
 *   per-repo pause state (`mm pause`/`mm resume`) the loop's enable-check reads
 * - `registerManagedRepo` (+ `ManagedRepo`) — record a repo's checkout in the
 *   managed-repo registry (`mm init` calls it so the recommender cron finds it)
 * - `EventHub` (+ `Event`) — the control plane's SSE broadcast hub
 * - `HookServer` (+ `SessionGate`, `ControlPlane`, `ControlDispatchInput`) — the
 *   hook receiver + `/control` + `/health` surface
 * - `startPoller` / `POLLER_INTERVAL_MS`, `startWatchdog` / `WATCHDOG_INTERVAL_MS`
 *   — the reconciliation crons
 * - `startRetentionCron` / `runRetentionPass` / `collectRetentionStatus` — the
 *   daily SQLite retention cron + the status `mm doctor` reads
 * - `openDb` / `openAndMigrate` / `MIGRATIONS_DIR` — the dispatcher database
 * - `WorkflowRecord` / `WorkflowState` — workflow persistence types
 *
 * Where things live:
 * - `main.ts` — the process entry (`mm start` spawns it); the daemon owns the
 *   one long-lived engine that hosts every dispatch + review-resume, and wires
 *   the four auto-dispatch triggers
 * - `auto-dispatch.ts` — the auto-dispatch loop; `slots.ts` — slot accounting
 * - `build-deps.ts` — the shared implementation-workflow deps + gate factory
 * - `epics-cache.ts` — the Epic browse cache (`refreshEpics` / `readEpics` /
 *   `EpicRow`); upserts from GitHub, marks vanished Epics `closed`
 * - `github.ts` — GitHub access seam; includes `listOpenEpics` / `parseEpicsList`
 *   and the `EpicListItem` type (the poller's raw Epic discovery)
 * - `event-hub.ts` — the SSE broadcast hub the control plane serves
 * - `hook-server.ts`, `hook-store.ts` — receive + persist hooks; `/control` + `/health`
 * - `metrics.ts` — queue observability: the `/metrics` (Prometheus) +
 *   `/control/metrics` (JSON) snapshot exports
 * - `poller*.ts` / `watchdog*.ts` — the GitHub-poll + liveness crons
 * - `retention.ts` / `retention-cron.ts` — the daily events-prune +
 *   workflow-archival pass and its cron wrapper
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
export { runDaemon } from "./main.ts";
export type { DaemonHostContext, RunDaemonOptions } from "./main.ts";
export { buildImplementationDeps } from "./build-deps.ts";
export { autoDispatch } from "./auto-dispatch.ts";
export type { AutoDispatchDeps, AutoDispatchResult } from "./auto-dispatch.ts";
export { getSlotState, hasFreeSlot, reserveSlot } from "./slots.ts";
export type { SlotDimension, SlotLimits, SlotState } from "./slots.ts";
export {
  clearPaused,
  getPausedUntil,
  isPaused,
  type ManagedRepo,
  registerManagedRepo,
  setPausedUntil,
} from "./repo-config.ts";
export { EventHub } from "./event-hub.ts";
export type { Event, WorkflowEventData } from "./event-hub.ts";
export { POLLER_INTERVAL_MS, startPoller } from "./poller-cron.ts";
export { startWatchdog, WATCHDOG_INTERVAL_MS } from "./watchdog-cron.ts";
export { startRetentionCron } from "./retention-cron.ts";
export {
  collectRetentionStatus,
  EVENTS_MAX_AGE_MS,
  getLatestRetentionRun,
  RETENTION_CRON_INTERVAL_MS,
  type RetentionRun,
  type RetentionStatus,
  runRetentionPass,
  WORKFLOWS_MAX_AGE_MS,
} from "./retention.ts";
export { MIGRATIONS_DIR, openAndMigrate, openDb } from "./db.ts";
export { HookServer } from "./hook-server.ts";
export type { ControlDispatchInput, ControlPlane, SessionGate } from "./hook-server.ts";
export type { WorkflowRecord, WorkflowState } from "./workflow-record.ts";
