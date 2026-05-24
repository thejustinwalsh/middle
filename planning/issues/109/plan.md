# Issue #109: Daemon-owned dispatch with an HTTP/SSE control plane

**Link:** https://github.com/thejustinwalsh/middle/issues/109
**Branch:** middle-issue-109

## Goal
Collapse the dual-engine architecture so the **daemon** (`mm start`) owns the one
long-lived bunqueue engine that hosts every dispatch *and* every review-resume
continuation; `mm dispatch` becomes a thin HTTP client of the daemon's control
plane. This fixes the bug where a parked workflow dies when `dispatchEpic`'s
throwaway engine settles-and-tears-down before the poller (which only lives in
the daemon) can resume it.

## Approach
- Port `restruct`'s control-plane shape: an HTTP server on `dispatcherPort` +
  an SSE broadcast hub (init-replay + heartbeat + drop-on-full). Reuse the
  existing localhost-only `HookServer` rather than standing up a 2nd server.
- Land it in 6 small, independently-verified phases (= the 6 sub-issues),
  bottom-up so each phase is a small diff and the standalone path is deleted
  last (after its replacement client tests are green).
- Strict TDD throughout (repo convention). Each phase: failing test → impl →
  green → typecheck → tick the Status box → push.
- The daemon's engine stays in-memory (`embedded`, no `dataPath`). Durable
  persistence across restart is **deliberately deferred** (#116) — do NOT add a
  no-op `engine.recover()` against in-memory state.

## Phases (one per sub-issue)
1. **#110** — Extract `buildImplementationDeps(...)` factory from `dispatchEpic`
   (no behavior change). `enqueueContinuation` injected by caller.
2. **#111** — `event-hub.ts`: SSE hub (`subscribe`/`unsubscribe`/`broadcast` +
   `serve(req)`), connected frame → init-replay → live, 15s heartbeat,
   drop-on-full, abort-only-unsubscribe.
3. **#112** — Add `GET /health`, `GET /control/events`, `POST /control/dispatch`
   (with body validation + 409 non-terminal-collision guard) to `HookServer`;
   engine/hub/version injected & optional.
4. **#113** — Wire the daemon's engine: register the workflow via the factory,
   construct it WITH `prReadyGate` + injected engine/hub/version, hybrid event
   source (bunqueue `onAny` + `updateWorkflow` observer for DB-only states),
   init-replay from in-flight rows, relocate the lock-token swallower here.
5. **#114** — Rewrite `runDispatch` body into an HTTP client: probe `/health`,
   auto-start daemon via `runStart()` + poll readiness, `POST /control/dispatch`,
   stream `/control/events` filtered to the workflow, exit on terminal/park.
6. **#115** — Delete `dispatchEpic`'s engine + HookServer bring-up + `waitForSettle`;
   remove the obsolete EADDRINUSE test; confirm no `dispatchEpic` imports remain.

## Files likely to change
- `packages/dispatcher/src/build-deps.ts` — NEW factory (#110)
- `packages/dispatcher/src/event-hub.ts` — NEW SSE hub (#111)
- `packages/dispatcher/src/hook-server.ts` — control/health routes (#112)
- `packages/dispatcher/src/main.ts` — daemon wiring (#113)
- `packages/dispatcher/src/dispatch.ts` — consume factory (#110), delete engine path (#115)
- `packages/dispatcher/src/index.ts` — front-door exports + frontmatter upkeep
- `packages/cli/src/commands/dispatch.ts` — thin control client (#114)
- tests: `build-deps.test.ts`, `event-hub.test.ts`, `control-routes.test.ts`
  (or extend `hook-server.test.ts`), `main.test.ts`, `cli/test/dispatch.test.ts`

## Out of scope
- Durable persistence of parked executions across daemon restart (#116, deferred).
- Slot accounting / per-adapter limits (#49) — the 409 guard is the only
  collision protection in this epic.
- Auto-dispatch loop (#48/#49/#50) and dashboard (#54/#57) — they consume the
  `/control/dispatch` and `/control/events` seams this epic builds.

## Open questions
- None blocking. The restruct Go source referenced in the issues is not on this
  machine, but #111 specifies the EventHub contract fully (connected → init →
  live, 15s heartbeat, bounded per-client buffer drop-on-full, abort →
  unsubscribe-only), which is sufficient to port.
