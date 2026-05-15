# Epic #6 — decisions log

## Migration runner records the version, the migration SQL may too
**File(s):** `packages/dispatcher/src/db.ts:55`
**Date:** 2026-05-14

**Decision:** `runMigrations` applies each pending file in its own transaction, then
runs `INSERT OR IGNORE INTO schema_version (version) VALUES (?)`. `001_initial.sql`
also contains its own `INSERT INTO schema_version VALUES (1)` (verbatim from the spec).
**Why:** The spec's `001_initial.sql` self-inserts its version row, but relying on every
future migration author to remember that is fragile. The runner's `INSERT OR IGNORE`
makes version tracking a property of the runner, not a convention each `.sql` file must
honor — while staying a harmless no-op for 001, which already inserted the row. Keeps the
spec's SQL block byte-for-byte and still makes the runner self-sufficient.
**Evidence:** Idempotency test (`runMigrations` twice → version stays 1, no throw).

## WAL assertions require a file-backed database
**File(s):** `packages/dispatcher/src/db.ts:16`, `packages/dispatcher/test/db.test.ts`
**Date:** 2026-05-14

**Decision:** `openDb` sets `PRAGMA journal_mode = WAL`; the test suite opens databases
under a `mkdtempSync` temp dir rather than `:memory:`.
**Why:** SQLite silently keeps `:memory:` databases in "memory" journal mode — a
`:memory:` test would assert `journal_mode = "memory"` and either fail or force a weaker
assertion. A real temp file is the only way to verify the production WAL path.
**Evidence:** `openDb opens a file database in WAL mode` test asserts `journal_mode = "wal"`.

## Config merge is a generic deep merge; per-repo sections are optional on the type
**File(s):** `packages/core/src/config.ts:126`
**Date:** 2026-05-14

**Decision:** `loadConfig` deep-merges the raw parsed tables (per-repo over global,
arrays/scalars replaced wholesale) *before* mapping to the typed object. Global-derived
sections (`global`, `adapters`, `dashboard`) are always present — `GLOBAL_DEFAULTS`
fills any gap — while per-repo sections (`repo`, `limits`, `recommender`, `stateIssue`,
`bootstrap`) are typed `T | undefined` and populated only when the per-repo file exists.
**Why:** The spec says "per-repo overrides global" but the two files have almost
disjoint sections — a literal field-by-field override list would be brittle. A generic
deep merge means a per-repo file *can* override any global key (e.g. drop in its own
`[global]` block) for free, and the disjoint common case still works. Making per-repo
sections optional is honest: there is no sensible default for `repo.owner`, so a
global-only load leaves them `undefined` rather than inventing values.
**Evidence:** `per-repo values override global on a colliding key` test (repo file with
its own `[global]` block wins); `global only` and `missing files` tests.

## classifyStop detects done/failed via sentinels, not PR state, in Phase 1
**File(s):** `packages/adapters/claude/src/classify.ts:18`
**Date:** 2026-05-14

**Decision:** `classifyStop` returns `done` when `<cwd>/.middle/done.json` exists and
`failed` when `<cwd>/.middle/failed.json` exists — sentinel files parallel to the
`.middle/blocked.json` question sentinel. The interface signature
(`{ payload, transcriptPath, sentinelPresent }`) carries no PR handle.
**Why:** The spec describes `classifyStop` as "reads PR state for `done`", but the fixed
interface gives the adapter no PR number and no GitHub client — and Phase 1 explicitly
ships no skill enforcement or hook taxonomy. A sentinel keeps `done`/`failed`
deterministically classifiable (so every branch is unit-testable, per #9's acceptance)
without inventing dependencies. Phase 4's mechanically-enforced PR-ready hook gate
replaces the `done.json` path with the real "agent ran `gh pr ready`" signal.
**Evidence:** `classifyStop` tests cover all five branches against temp `.middle/` dirs.

## enterAutoMode shells out to tmux directly; adapter does not depend on dispatcher
**File(s):** `packages/adapters/claude/src/index.ts:15`
**Date:** 2026-05-14

**Decision:** `enterAutoMode` runs `tmux send-keys -t <session> S-Tab S-Tab` via
`Bun.spawn` inside the adapter package, rather than calling the dispatcher's `tmux.ts`
helper module.
**Why:** `@middle/adapter-claude` depends on `@middle/core` only; the tmux helpers live
in `@middle/dispatcher`, and an adapter → dispatcher dependency would invert the layering.
Entering auto mode is intrinsically a per-CLI keystroke concern the adapter owns, and the
keystroke call is two tokens of `tmux` — not worth a shared abstraction. Not unit-tested
in Phase 1 (needs a live tmux session); exercised by #12's workflow integration.
**Evidence:** dependency graph stays `adapters/* → core`; #9 acceptance does not require
an `enterAutoMode` unit test.

## Minimal hook receiver handles two events, not just SessionStart
**File(s):** `packages/dispatcher/src/hook-server.ts:19`
**Date:** 2026-05-14

**Decision:** The Phase 1 `HookServer` receives both `session.started` (readiness +
`session_id`/`transcript_path` discovery) and `agent.stopped` (the turn boundary) — not
SessionStart alone.
**Why:** Build sequence item 10 names it the "minimal SessionStart hook receiver", but
#12's `launch-and-drive` must "react to the Stop boundary via classifyStop", and the
Phase 1 acceptance gate is "the agent hits a Stop; classifyStop runs". A SessionStart-only
receiver could not drive the 3-step workflow to its acceptance gate. "Minimal" still holds
relative to Phase 2: no HMAC auth, no events-table persistence, no full taxonomy — just
the two load-bearing events the launch→drive→observe loop cannot run without.
**Evidence:** `hook-server.test.ts` covers both event types; `implementation-workflow.test.ts`
drives the full loop through a stub `SessionGate`.

## Workflow factory + structural deps; failure state is `compensated`, agent-failure is `failed`
**File(s):** `packages/dispatcher/src/workflows/implementation.ts:78`
**Date:** 2026-05-14

**Decision:** `createImplementationWorkflow(deps)` is a factory closing over a `deps`
bundle (db, adapter registry, `SessionGate`, structural `TmuxOps`/`WorktreeOps`, path
resolvers). `launch-and-drive` wraps its body in try/catch and kills the session on any
throw before rethrowing. Terminal DB states: a step that *throws* ends `compensated` (set
by the prepare-worktree compensation); a clean run whose `classifyStop` returns `failed`
ends `failed`. The bunqueue execution id doubles as `workflows.id`.
**Why:** bunqueue's `StepContext` carries only input/steps/signals — ambient collaborators
must come via closure, and a factory keeps the workflow a pure builder the dispatcher and
tests configure identically. Structural `TmuxOps`/`WorktreeOps` let the end-to-end test
stub tmux while using the *real* worktree helpers, so "no worktree leak" is genuinely
verified. The catch-kill is needed because bunqueue runs compensation only for *completed*
steps — a step that fails mid-launch would otherwise leak its tmux session. Separating
`compensated` (workflow error, rolled back) from `failed` (agent reported failure, ran to
completion) keeps the terminal state honest about *what* failed.
**Evidence:** `implementation-workflow.test.ts` — happy path → `completed`, `failed`
classifyStop → `failed`, launch throw → `compensated`; all three assert zero worktree and
session leaks. bunqueue retries the failing step by default; the leak check tolerates that
by asserting every *distinct* created session was killed.

## bunqueue runs in-memory in tests (no dataPath)
**File(s):** `packages/dispatcher/test/implementation-workflow.test.ts:38`
**Date:** 2026-05-14

**Decision:** The test `Engine` is constructed `{ embedded: true }` with no `dataPath`.
**Why:** With a `dataPath`, bunqueue's `SqliteStorage` opens a file-backed queue DB; under
a `mkdtemp` dir on macOS its write-buffer flushes during the retry path hit
`SQLITE_IOERR_VNODE` ("disk I/O error"). Omitting `dataPath` makes both the queue and the
workflow store in-memory — isolated per `Engine`, no vnode churn. The production dispatcher
(Phase 1 CLI / Phase 2) supplies a real `dataPath`; only the test runs in-memory.
**Evidence:** the I/O error reproduced reliably on the compensation (retry) test with a
temp-dir `dataPath` and vanished once `dataPath` was dropped.
