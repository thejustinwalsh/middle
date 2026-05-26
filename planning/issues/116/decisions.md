# Decisions — Issue #116

## Persistent `dataPath` derived next to `db.sqlite3`, not a new config knob
**File(s):** `packages/dispatcher/src/main.ts`
**Date:** 2026-05-26

**Decision:** The workflow Engine's `dataPath` is `join(dirname(config.global.dbPath), "queue.sqlite3")` — derived, no new `[global]` config field.
**Why:** The issue says "alongside the SQLite db under the middle data dir." Deriving keeps the change minimal and keeps the queue store co-located with `db.sqlite3` (one data dir to back up / wipe). A config knob is YAGNI until someone needs to relocate it. The dir is already `mkdirSync`'d for `db.sqlite3`, so no extra mkdir.
**Evidence:** `config.global.dbPath` default `~/.middle/db.sqlite3` (`packages/core/src/config.ts:136`); bunqueue opens `dataPath` with `{create:true}` but does not mkdir the parent.

## Boot cleanup of `running`/`compensating` execs before `recover()`
**File(s):** `packages/dispatcher/src/recovery.ts`, `main.ts`
**Date:** 2026-05-26

**Decision:** Before `engine.recover()`, call `engine.cleanup(0, ["running", "compensating"])` to delete mid-drive executions from the persistent store, so `recover()` re-arms only parked `waiting` executions.
**Why:** `recover()` is all-or-nothing: it re-enqueues `running` execs (re-running `launch-and-drive`) and re-runs `compensating` ones. The issue explicitly scopes running-execution recovery OUT ("a tmux session lost to a restart is the watchdog's domain"). A daemon restart does NOT kill the agent's tmux sessions (they're not daemon children), so re-driving a `running` exec would launch a SECOND session alongside the live one — a regression. Dropping them preserves today's behavior exactly: the watchdog reconciles `launching`/`running` rows on its first tick (tmux liveness / launch-timeout). `cleanup(0, …)` deletes execs with `updated_at < now`, which is every pre-restart row.
**Evidence:** `dist/client/workflow/recovery.js` (`running` → `enqueueExecution`); watchdog acts on `state IN ('launching','running')` (`watchdog.ts`); spike confirmed `cleanup` semantics.

## Use `engine.recover()` even though `signal()` already reads the durable store
**File(s):** `packages/dispatcher/src/main.ts`
**Date:** 2026-05-26

**Decision:** Call `engine.recover()` on boot (AC2), not just rely on `engine.signal` working post-restart.
**Why:** A spike showed `engine.signal(id, …)` resumes a parked exec from the durable store WITHOUT `recover()` — so resume technically works either way. But `recover()` is what re-arms the `waitFor` **timeout timer** (the 7-day park cap), so without it a parked workflow that nobody resumes would never time out after a restart. The AC also mandates it. `recover()` resuming a signal that arrived during downtime is a bonus.
**Evidence:** `dist/client/workflow/executor.js` `signal`/`getExecution` both read `this.store.get`; `recovery.js` `recoverWaiting` re-arms via `scheduleTimeoutCheck`.

## Orphaned parked signal → finalize `failed` + surface, not silently left
**File(s):** `packages/dispatcher/src/recovery.ts`
**Date:** 2026-05-26

**Decision:** On boot, an armed `waitfor_signals` row on a `waiting-human` workflow whose `engine.getExecution(id)` is null is an orphan: log it, post a best-effort Epic comment, consume the signal row, and `finalizeParkedWorkflow(id, "failed")`.
**Why:** Post-restart the execution should be recoverable from the durable store; an orphan means the store never had it (a legacy in-process park from before this feature, or a wiped queue db). The bug the issue calls out is the poller firing `engine.signal` at a dead execution — which throws `Execution "<id>" not found` every pass forever (silently stuck). Finalizing to a terminal state stops the poller (its `loadPollableWaits` only sees `waiting-human` rows), frees the slot, and makes the failure visible. `failed` (vs `cancelled`) because it genuinely failed to recover and warrants a human look; `finalizeParkedWorkflow` is conditional on the row still being `waiting-human`, so it can't clobber a concurrent resume. Open to `cancelled` on reviewer preference.
**Evidence:** spike: `signal` on a missing id throws "not found"; `loadPollableWaits` JOINs on `w.state = 'waiting-human'` (`workflow-record.ts`).

## Test restarts via `shutdownManager()`
**File(s):** `packages/dispatcher/test/*`
**Date:** 2026-05-26

**Decision:** Tests simulate a daemon restart by `engine.close(true)` then `shutdownManager()` (from `bunqueue/client`) before constructing the second `Engine` on the same `dataPath`.
**Why:** bunqueue's embedded queue/worker route through a process-level singleton `QueueManager` (`dist/client/manager.js`). Within one test process, a second `Engine` reuses the first (now closed) manager and never processes the resume — unless the singleton is reset. `shutdownManager()` resets it, faithfully modelling the fresh module state of a real separate-process restart. A spike confirmed the full park → restart → recover → signal → resume path works with this.
**Evidence:** `getSharedManager` singleton in `dist/client/manager.js`; spike `spike5.ts`.
