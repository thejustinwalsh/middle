# Issue #116: Persist parked executions across daemon restart (durable bunqueue store)

**Link:** https://github.com/thejustinwalsh/middle/issues/116
**Branch:** middle-issue-116

## Goal
Make the daemon's bunqueue workflow engine durable so a parked `waiting` execution
survives a daemon restart: on boot the engine recovers parked executions and the
poller can still fire their resume signal — no orphaned `waitfor_signals` row left
pointing at a dead execution.

## Approach
- Give the one long-lived workflow `Engine` a persistent `dataPath`
  (`<dbdir>/queue.sqlite3`, alongside `db.sqlite3` under the middle data dir),
  keeping `embedded: true` (in-process worker). The dir is already `mkdir`'d for `db.sqlite3`.
- On boot, before the poller/watchdog crons start:
  1. `engine.cleanup(0, ["running", "compensating"])` — drop mid-drive executions so
     `recover()` re-arms **only** parked `waiting` ones. Recovering `running`
     (mid-drive) executions is explicitly out of scope (the watchdog's domain); the
     blanket `recover()` would otherwise re-drive them and double-launch a session.
  2. `await engine.recover()` — re-arm parked `waiting` executions' timeout timers
     (and resume any whose signal arrived during downtime).
  3. Reconcile orphaned signals — any armed `waitfor_signals` row on a `waiting-human`
     workflow with **no recoverable execution** (`engine.getExecution(id) === null`)
     is surfaced (log + best-effort Epic comment) and the row finalized, so the
     poller stops firing `engine.signal` at an execution that throws "not found".
- Verify with: a restart-resume e2e test (uses `shutdownManager()` to simulate a real
  separate-process restart in one test process) + orphan-reconciliation unit tests.

## Phases
1. **Persistent engine + boot recovery** — `dataPath` on the Engine; `recovery.ts`
   with `recoverEngine` (cleanup + recover); wire into `main.ts` boot.
2. **Orphaned-signal reconciliation** — `reconcileOrphanedSignals` in `recovery.ts`
   (+ a `loadArmedParkedSignals`-style query reuse); wire into `main.ts` boot with a
   GitHub surface seam.
3. **Tests + docs** — restart-resume e2e (implementation-workflow harness, persistent
   dataPath) + orphan unit tests; update dispatcher `CLAUDE.md` and `index.ts` front door.

## Files likely to change
- `packages/dispatcher/src/main.ts` — Engine `dataPath`; boot recover/cleanup/reconcile wiring.
- `packages/dispatcher/src/recovery.ts` — **new**: `recoverEngine` + `reconcileOrphanedSignals`.
- `packages/dispatcher/src/workflow-record.ts` — a query for armed signals on parked rows (if not reusing `loadPollableWaits`).
- `packages/dispatcher/src/index.ts` — export the new recovery surface; update front-door frontmatter.
- `packages/dispatcher/CLAUDE.md` — replace the "in-memory; don't add a no-op recover()" note with the durable-store reality.
- `packages/dispatcher/test/recovery.test.ts` — **new**: orphan reconciliation + `recoverEngine` unit tests.
- `packages/dispatcher/test/implementation-workflow.test.ts` — add the restart-resume e2e describe.

## Out of scope
- Broader crash-recovery of `running` (mid-drive) executions — a lost tmux session is
  the watchdog's domain. This change deliberately *preserves* that boundary (the boot
  cleanup drops running/compensating execs rather than re-driving them).

## Open questions
- Orphan disposition: finalize an unrecoverable parked workflow as `failed` (chosen —
  visible, frees the slot, stops the poller) vs `cancelled`. Documented in decisions.md;
  open to reviewer preference.
