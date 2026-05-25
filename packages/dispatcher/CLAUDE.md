# @middle/dispatcher — local conventions

Local invariants for the long-running dispatcher — the non-obvious facts behind bunqueue's lifecycle and the watchdog. Root `CLAUDE.md` wins on any conflict.

## bunqueue lifecycle & the lock-token race

- bunqueue's worker can throw `Invalid or expired lock token for job …` from inside `handleJobFailure` when the engine shuts down concurrently with a failing job. It surfaces as a runtime-killing `unhandledRejection`. `installBunqueueRaceSwallower` (in `bunqueue-race.ts`) swallows **only** that exact message and re-raises everything else. Don't broaden the match — any other rejection must still crash the way Bun would. The daemon (`main.ts`) installs it for its lifetime; the ephemeral recommender run (`recommender-run.ts`) installs it for the run.
- The engine runs `embedded: true` (in-process). The **daemon** owns the one long-lived engine that hosts every dispatch *and* every review-resume continuation (the poller's `fireSignal` targets it). It's in-memory: parked executions don't survive a daemon restart — durable persistence is deferred (#116), so don't add a no-op `engine.recover()`. Treat shutdown as racy: a job may still be settling when teardown begins (hence the swallower).
- **Two SSE broadcast sources, both load-bearing.** Workflow state reaches `/control/events` via a hybrid: `engine.onAny` for bunqueue-native lifecycle states (`running`/`waiting`/`completed`/`failed`/`compensating`) **plus** a workflow observer (on `updateWorkflow`) for middle's DB-only states (`launching`/`waiting-human`/`compensated`/`rate-limited`) bunqueue never emits. Drop either and the feed loses transitions a client relies on. The wire `state` is therefore the **union** of both vocabularies (a parked review surfaces both bunqueue `waiting` and middle `waiting-human`); consumers must understand both. The two sources **overlap** on `completed` (the workflow writes it to the row *and* bunqueue emits it), so `broadcastWorkflow` collapses a consecutive identical `(id, state)` frame to avoid a double-broadcast. The workflow observer is a process-global **fan-out** (`addWorkflowObserver` returns a per-observer disposer; `clearWorkflowObservers` empties it): the daemon registers the control-feed broadcaster on startup and clears all on shutdown, and the dashboard registers a second observer (a repo-channel nudge) when mounted. The rate-limit observer (`addRateLimitObserver`/`clearRateLimitObservers`) follows the same fan-out shape — never replace a fan-out registration with a single-slot setter again (a second `set*` would clobber the first; this was a real regression).

## Epic browse cache (`epics` table / `epics-cache.ts`)

- Refreshed on a fixed `EPICS_REFRESH_INTERVAL_MS = 60_000` sweep (in `main.ts`, alongside the poller/watchdog crons) **and** after each force-dispatch. Vanished Epics (no longer in GitHub's open set) are marked `closed`, never deleted — this prevents a just-closed Epic from flickering out mid-view. `readEpics` returns only `state = 'open'` rows.

## Watchdog: staleness only, never override a live decision

- The watchdog is the safety net *behind* the hook stream — it acts only on **staleness**, never overriding an in-progress hook decision. Hooks + the on-disk transcript are the fast path and the source of truth; the watchdog reconciles drift.
- Cadence is fixed: `WATCHDOG_INTERVAL_MS = 30_000`, `POLLER_INTERVAL_MS = 60_000`. The reconcile passes (launch-timeout → tmux liveness → activity freshness → sentinel re-arm) run every tick over `launching`/`running` workflows.
- **Freshness checks are skipped while `controlled_by = 'human'`.** A human-controlled session must never be idle-killed; preserve that guard in any freshness change.
- The sentinel pass re-arms a `waitFor` signal when `<worktree>/.middle/blocked.json` exists with no armed signal — this handles the agent-wrote-the-sentinel-after-we-advanced race. Don't drop it; it's load-bearing for the blocked/resume handshake.

## The runnable entry is `main.ts`, not `index.ts`

`package.json` `main` is `src/main.ts` (the process `mm start` spawns). `src/index.ts` is the documented API front door (re-exports only). Adding a runtime side effect belongs in `main.ts`; `index.ts` must stay side-effect-free.
