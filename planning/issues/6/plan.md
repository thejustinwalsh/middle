# Issue #6: Minimal dispatcher (worktree, spawn, cleanup)

**Link:** https://github.com/thejustinwalsh/middle/issues/6
**Branch:** worktree-6-minimal-dispatcher

## Goal
Build build-spec Phase 1 — the minimal dispatcher: persistence, config, the adapter
interface with one concrete adapter, tmux/worktree helpers, a 3-step `implementation`
workflow, and the `mm start/stop/status` + `mm dispatch` CLI. No hooks taxonomy, no
skill enforcement (Phase 2/4).

## Approach
- One Epic = one branch = one PR; the 7 sub-issues are the 7 phases, worked continuously.
- TDD throughout: every new module ships with `bun test` coverage in a sibling `test/`.
- Phase order respects the sub-issues' `Blocked by` graph: 7 → 8 → 9 → 10 → 11 → 12 → 13.
- The build spec (`planning/middle-management-build-spec.md`) is authoritative for the
  SQLite schema, adapter interface, event taxonomy, config shape, and CLI surface.
- bunqueue ≥2.7.12 provides `Workflow` + `Engine` (`bunqueue/workflow`); the workflow is
  a pure builder, the `Engine` runs it embedded with a `dataPath`.

## Phases
1. **#7 — SQLite migrations + WAL db wrapper.** `packages/dispatcher/src/db.ts`,
   numbered `.sql` migrations under `src/db/migrations/`, migration runner +
   `schema_version`. `001_initial.sql` creates every table from the spec's "SQLite schema".
2. **#8 — TOML config loader.** `packages/core/src/config.ts` — parse + merge global
   (`~/.middle/config.toml`) and per-repo (`<repo>/.middle/config.toml`) via `smol-toml`,
   per-repo overrides global, `~` paths expanded.
3. **#9 — AgentAdapter interface + ClaudeAdapter.** `packages/core/src/adapter.ts` +
   `events.ts`; `packages/adapters/claude/` implements `buildLaunchCommand`,
   `buildPromptText`, `enterAutoMode`, `classifyStop`, `resolveTranscriptPath`,
   `readTranscriptState`, minimal `SessionStart`-only `installHooks` stub.
4. **#10 — tmux session helpers.** `packages/dispatcher/src/tmux.ts` — `newSession`,
   `sendText` (`-l`), `sendEnter`, `capturePane`, `hasSession`, `status`, `killSession`;
   typed errors; lifecycle test skipped gracefully when `tmux` is absent.
5. **#11 — git worktree helpers.** `packages/dispatcher/src/worktree.ts` —
   create/destroy/list under `~/.middle/worktrees/<repo>/issue-<n>/`; idempotent.
6. **#12 — 3-step implementation workflow.** `packages/dispatcher/src/workflows/
   implementation.ts` — bunqueue `Workflow` with prepare-worktree → launch-and-drive →
   cleanup; minimal `SessionStart` receiver; `workflows` row transitions
   pending → launching → running → completed; end-to-end test against a stub adapter.
7. **#13 — mm CLI.** `packages/cli/src/` — commander wiring, `mm start/stop/status`,
   `mm dispatch`; `scripts/dev.sh`; config via the loader; non-zero exit on error.

## Files likely to change
- `packages/dispatcher/src/db.ts`, `src/db/migrations/001_initial.sql` — new
- `packages/core/src/config.ts` — replace the Phase-0 minimal `RepoConfig` stub with the full loader
- `packages/core/src/adapter.ts`, `src/events.ts`, `src/index.ts` — new / updated exports
- `packages/adapters/claude/src/{index,prompt,classify,hooks}.ts` — new
- `packages/dispatcher/src/{tmux,worktree}.ts`, `src/workflows/implementation.ts`,
  `src/hook-server.ts` (minimal), `src/main.ts` — new / updated
- `packages/cli/src/index.ts` + `src/commands/*` — new
- `scripts/dev.sh` — new
- sibling `test/` dirs in each package

## Out of scope
- Full hook taxonomy, HMAC auth, events-table population, watchdog, reconciler cron (Phase 2)
- `installHooks` writing the whole `.claude/settings.json` event set (Phase 2)
- CodexAdapter (Phase 10); recommender workflow (Phase 7)
- Skill enforcement gates (Phase 4); `mm init`/`uninit`/`doctor`/dashboard (Phases 3/9/11)
- Retention crons for `events`/`workflows` (Phase 11)

## Open questions
- `enterAutoMode` mechanism (launch flag vs. `S-Tab S-Tab`) is empirical; the keystroke
  path is the guaranteed fallback and what this phase ships. Resolved at implementation.
- `RepoConfig` (used by `@middle/state-issue`'s `validate()`) currently only carries
  `adapters: string[]`; the full config type must keep that field shape compatible.
