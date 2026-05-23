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
