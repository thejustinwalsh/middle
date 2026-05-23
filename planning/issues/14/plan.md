# Issue #14: Hooks and watchdog (Phase 2)

**Link:** https://github.com/thejustinwalsh/middle/issues/14
**Branch:** middle-issue-14

## Goal
Build Phase 2's observability layer: a full HMAC-validated hook receiver, the
universal hook script, the full Claude hook-event set, event/heartbeat
persistence into SQLite, the watchdog reconciler cron, and reactive rate-limit
detection. Hooks are the fast-path notification; the on-disk transcript +
SQLite are the durable state crons reconcile against.

## Approach
- Keep the existing `HookServer` `SessionGate` mechanics (stash/deliver/await)
  intact — they're load-bearing for `launch → drive`. Layer HMAC auth, full
  event-name validation, and a pluggable persistence sink on top.
- Single-source the universal hook script as a `@middle/core` constant; ship it
  as a committed bootstrap asset and have the Claude adapter write the same
  bytes. A drift test keeps them in lockstep (mirrors the skills-sync pattern).
- Build the watchdog and rate-limit logic as pure, injectable reconcile
  functions (db + tmux stub + transcript reader + clock) so each path is unit
  tested without real timers or a live agent; wire thin bunqueue crons in
  `main.ts`.
- The SQLite schema already has every table/column Phase 2 needs (`events`,
  `rate_limit_state`, `waitfor_signals`, `last_heartbeat`) — no migration.

## Phases (one per sub-issue, in dependency order)
1. **#15** — Hook server: HMAC-validated `POST /hooks/:event`, full event-name
   validation, `session.started` records `session_id`+`transcript_path` and
   signals readiness, bodies handed to a persistence sink seam.
2. **#16** — `ClaudeAdapter.installHooks` writes the full 8-hook
   `.claude/settings.json` mapped to the normalized taxonomy.
3. **#17** — Universal `hook.sh` as a committed bootstrap asset
   (`packages/cli/src/bootstrap-assets/hooks/hook.sh`), single-sourced from core.
4. **#18** — `DbHookStore`: persist an `events` row per hook (payload ≤16KB),
   bump `last_heartbeat` on `tool.pre`/`tool.post`, write session fields on
   `session.started`, correlate by session, drop unknown sessions.
5. **#19** — Watchdog cron (every 30s): launch-timeout, tmux liveness, heartbeat
   freshness (idle/idle-kill, skip `controlled_by='human'`, transcript
   cross-check), sentinel re-arm; companion transcript reconciler.
6. **#20** — Reactive rate-limit: `detectRateLimit` + `rate_limit_state`
   read/write, classifyStop path persists `RATE_LIMITED`+`reset_at`, revert to
   `AVAILABLE` on next successful dispatch.

## Files likely to change
- `packages/dispatcher/src/hook-server.ts` — HMAC, event validation, sink seam
- `packages/dispatcher/src/hook-store.ts` — NEW: `DbHookStore` (events + heartbeat)
- `packages/dispatcher/src/watchdog.ts` — NEW: reconcile functions + cron wiring
- `packages/dispatcher/src/rate-limits.ts` — NEW: `rate_limit_state` read/write
- `packages/dispatcher/src/workflow-record.ts` — event/heartbeat/session helpers
- `packages/dispatcher/src/workflows/implementation.ts` — rate-limit persistence on Stop
- `packages/dispatcher/src/main.ts` + `dispatch.ts` — wire store + crons
- `packages/core/src/events.ts` (or new) — canonical `HOOK_SH` + event-name set
- `packages/adapters/claude/src/hooks.ts` — full event set, use core script
- `packages/adapters/claude/src/index.ts` — add `detectRateLimit`
- `packages/cli/src/bootstrap-assets/hooks/hook.sh` — NEW committed asset
- tests under each package's `test/`

## Out of scope (per sub-issue bodies)
- `waitFor` signal integration + sentinel detection in `classifyStop` (Phase 5)
- Auto-dispatch loop skipping rate-limited adapters / cross-run delayed
  re-enqueue (Phase 8)
- Event retention crons (Phase 11)
- Codex hook installation (Phase 10)
- Dashboard SSE channels (Phase 9)

## Open questions / flagged conflicts
- **#17 dogfood copy at `.middle/hooks/hook.sh`:** the dispatch skill's hard rule
  is "do not stage or commit anything under `.middle/`" (it's middle's
  operational dir for the running dispatch). The committed dogfood `.middle/`
  is created by Phase 3 task 22 (`mm init` middle into itself). The substantive
  deliverable — the reusable universal `hook.sh` asset — ships in
  `bootstrap-assets/`. The committed `.middle/hooks/hook.sh` is left to Phase 3
  to avoid violating the hands-off rule and committing this run's operational
  files. Flagged for reviewer.
