# Decisions — Issue #14 (Phase 2: hooks + watchdog)

## Persistence sink seam between hook server and DB
**File(s):** `packages/dispatcher/src/hook-store.ts`, `packages/dispatcher/src/hook-server.ts`
**Date:** 2026-05-23

**Decision:** Introduce a `HookStore` interface the `HookServer` calls, with a
`DbHookStore` implementation. The server stays a transport+auth layer; all
SQLite writes go through the store.
**Why:** #15 explicitly scopes "persisting events" to #18 but still needs token
resolution (auth) and the `session.started` field write. A single injected
interface lets #15 ship auth + session.started recording and #18 fill in the
events/heartbeat writes without re-touching the server. It also keeps the
`SessionGate` mechanics (stash/deliver) testable in isolation: `HookServer`
takes an *optional* store, so the gate-only unit tests run unauthenticated.
**Evidence:** Mirrors the existing dependency-injection style in
`createImplementationWorkflow` (db/tmux/worktree all injected).

## HMAC = per-session bearer token, timing-safe compared
**File(s):** `packages/dispatcher/src/hook-server.ts`
**Date:** 2026-05-23

**Decision:** "HMAC token" is the per-session `session_token` (a random UUID)
sent as `X-Middle-Token`. The server resolves the expected token from the
workflow row by `session_name` and compares it timing-safely; mismatch or
unknown session → 401.
**Why:** The hook script (`hook.sh`) forwards the token as a header, not a
signature over the body — so this is bearer-token auth, not a true HMAC over the
payload. The spec/issue language ("HMAC token") describes the secret, not a
signing scheme. Constant-time compare avoids a token-guessing oracle on the
localhost endpoint.
**Evidence:** `hook.sh` taxonomy in the build spec sends `X-Middle-Token:
${MIDDLE_SESSION_TOKEN}`; `launchAndDrive` persists `session_token` before the
session launches, so the row is always populated before any hook fires.

## Watchdog operates on DB + tmux state, not the live bunqueue execution
**File(s):** `packages/dispatcher/src/watchdog.ts`, `packages/dispatcher/src/watchdog-cron.ts`
**Date:** 2026-05-23

**Decision:** The watchdog reconciles the durable state (the `workflows` table +
tmux liveness + the on-disk transcript) and surfaces a `triggerCompensation`
callback. It marks a stuck workflow `failed`, records a `watchdog.failed` event
with the reason, and kills the session — it does **not** itself cancel the
bunqueue execution that is blocked in `awaitStop`.
**Why:** Cancelling a running workflow execution from outside the engine (so the
blocked `awaitStop` unwinds and bunqueue runs the registered compensation) is
the `waitFor`/cancellation integration that the spec scopes to Phase 5. Phase 2
delivers the *detection* and durable state correction; the `triggerCompensation`
seam is where Phase 5 plugs in real execution cancellation. The DB is the source
of truth the durable engine reconciles against on restart, so failing the row +
killing the session is the correct, complete Phase 2 action.
**Evidence:** Build spec → "Watchdog" (the watchdog acts on staleness, never
overrides in-progress hook decisions) and Phase 5 task 26 ("`waitFor` signal
integration in the implementation workflow").

## Idle is marked once per idle period, not every tick
**File(s):** `packages/dispatcher/src/watchdog.ts`
**Date:** 2026-05-23

**Decision:** The 30s tick records a `watchdog.idle` event only when the
workflow's most recent event is not already `watchdog.idle`.
**Why:** Without the guard, a genuinely-idle agent would accrue an idle event
every 30s (120/hour) until the kill threshold, flooding the events table and the
dashboard timeline. One marker per idle period is the signal the dashboard needs
("yellow"); the kill threshold handles escalation.
**Evidence:** Build spec → "Watchdog" activity-freshness tiers (idle marker is a
state, not a recurring alarm).
