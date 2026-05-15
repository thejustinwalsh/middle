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

## `mm dispatch` is self-contained; `dispatchEpic` lives in the dispatcher with an injected adapter registry
**File(s):** `packages/dispatcher/src/dispatch.ts:46`, `packages/cli/src/commands/dispatch.ts:30`
**Date:** 2026-05-14

**Decision:** `mm dispatch` does not talk to the long-running `mm start` process — it
calls `dispatchEpic` (in `@middle/dispatcher`), which stands up its *own* hook server +
bunqueue engine for the run and tears them down when the workflow settles. `dispatchEpic`
takes a `getAdapter` registry function as a parameter; the CLI supplies
`(name) => claudeAdapter`. The CLI never imports `bunqueue` or the workflow internals —
only `dispatchEpic` and `openDb`.
**Why:** Routing a force-dispatch into the running dispatcher needs an IPC/HTTP trigger
endpoint, which is Phase 8 (auto-dispatch loop) territory — Phase 1's minimal hook server
is the only HTTP surface and it has no control plane. A self-contained `mm dispatch` meets
the Phase 1 acceptance gate ("spawns Claude in tmux … workflow finalizes … worktree
cleaned up") with no Phase 8 machinery. Putting `dispatchEpic` in the dispatcher package
(not the CLI) keeps `bunqueue`/tmux/worktree/workflow coupling contained; passing
`getAdapter` in keeps `@middle/dispatcher` free of any concrete-adapter dependency, so the
dependency graph stays `cli → {dispatcher, adapter-claude}` with no `dispatcher → adapter-*`
edge. Phase 8 will add the HTTP trigger that lets `mm dispatch` enqueue into the running
process instead.
**Evidence:** `bun run typecheck` clean with the layered imports; `cli/test/dispatch.test.ts`
covers the fail-fast validation; the real Claude end-to-end is a manual verification step
(see the reviewer's brief — it needs the `claude` binary, GitHub auth, and a real repo).

## Review response (2026-05-15): six hot-path fixes
**File(s):** multiple
**Date:** 2026-05-15

**Decision:** Six fixes from Greptile review on PR #73:

1. **`Stop` hook registration** (`packages/adapters/claude/src/hooks.ts`) — `installHooks` now registers both `SessionStart` → `session.started` *and* `Stop` → `agent.stopped`. It also writes an executable `.middle/hooks/hook.sh` (the universal `curl` POST script from the spec) into the worktree. Without these, a real Claude session would never POST `agent.stopped`, the workflow's `awaitStop` would time out after 4 hours, and every real dispatch would compensate instead of completing.
2. **Sentinel paths anchored to the worktree** (`packages/core/src/adapter.ts`, `packages/adapters/claude/src/classify.ts`, `packages/dispatcher/src/workflows/implementation.ts`) — `classifyStop`'s opts now take `worktree: string`; `.middle/{blocked,done,failed}.json` are resolved from there, not from `payload.cwd` (which may be a subdirectory the agent `cd`'d into, and was falling back to `""` when absent). The caller now passes `handle.path`, matching the anchor already used for `sentinelPresent`.
3. **Resource cleanup on early failure** (`packages/dispatcher/src/dispatch.ts`) — `dispatchEpic` uses a cleanups-stack pattern (`cleanups.push(...)` as each resource is acquired, popped in reverse in a single `finally`). A throw from `hookServer.start()` (e.g. port already bound by a running `mm start` dispatcher) now still closes the db.
4. **`enterAutoMode` throws on non-zero `tmux` exit** (`packages/adapters/claude/src/index.ts`) — the exit code is now checked and stderr captured; a missing session or missing `tmux` binary surfaces as an error so `launchAndDrive`'s catch kills the session and the workflow compensates, instead of silently proceeding to send the prompt into a session that never entered auto mode.
5. **`waitForSettle` outer deadline** (`packages/dispatcher/src/dispatch.ts`) — a 5-hour outer guard (workflow's 4h `stopTimeoutMs` + buffer) so a `null` execution from bunqueue cannot spin the loop forever.
6. **Hook-server stash keeps the first arrival** (`packages/dispatcher/src/hook-server.ts`) — duplicate pre-await hooks no longer overwrite earlier payloads. Matters most for `session.started`, whose payload commits `session_id`/`transcript_path` onto the workflow row.

**Why:** Items 1 and 2 are correctness-blocking for the real-binary dispatch path the Phase 1 acceptance gate exercises. Items 3–6 are hardening on edge cases (port collision, missing tmux, engine-state corruption, retry-storm duplicate hooks) the real environment will inevitably exercise.
**How to apply:** Regression coverage added: subdir-cwd sentinel test, `enterAutoMode` rejects on missing tmux session, `installHooks` registers both events and writes an executable hook.sh, duplicate-pre-await stash keeps first. Full suite: 104 pass, `tsc` clean.

## Auto mode via --permission-mode launch flag, not S-Tab keystrokes
**File(s):** `packages/adapters/claude/src/index.ts:14`
**Date:** 2026-05-15

**Decision:** `buildLaunchCommand` now produces `["claude", "--permission-mode",
"bypassPermissions"]`. `enterAutoMode` is a no-op — auto mode is engaged at process
launch, not after `SessionStart` via keystrokes.
**Why:** The keystroke path had three real fragilities that surfaced during the manual
end-to-end run: (1) Claude's current mode cycle is `default → acceptEdits → plan →
bypassPermissions`, so two Shift-Tabs lands on *plan mode*, not bypass — the wrong mode
for autonomous dispatch; (2) `SessionStart` fires when the session boots but Claude's
TUI may not be input-ready, and the keystrokes have no readiness gate; (3) two key
events in one `send-keys` call can be debounced/missed. The launch flag avoids all
three: the process starts in the right mode, the mode persists for the session, and
there is nothing to mis-time. The spec's "open empirical question" — flag vs.
keystrokes — resolves to "flag works in interactive mode".
**Evidence:** `buildLaunchCommand` test asserts the new argv; the previous
`enterAutoMode failure surfacing` test (which expected a throw on a missing session) is
replaced by a no-op assertion. The keystroke path remains a documented fallback in case
a future Claude build removes the flag from interactive mode — it's the path the spec
called out as the "guaranteed fallback" and the interface still has the hook.

## Lifecycle hardening for repeated `mm dispatch` (2026-05-15)
**File(s):** `packages/dispatcher/src/dispatch.ts`, `packages/dispatcher/src/workflows/implementation.ts`
**Date:** 2026-05-15

**Decision:** Three changes to keep `mm dispatch` stable across repeated runs and failure paths:

1. **`engine.close(false)`** in `dispatchEpic`'s cleanups — let the bunqueue worker finish any in-flight job-failure finalization before shutdown. `close(true)` was forcing a teardown while `handleJobFailure` was still inside `throwIfOwnershipConflict`, surfacing as an unhandled `Invalid or expired lock token for job …` and killing the process.
2. **`retry: 1` on `launch-and-drive`** — bunqueue's `retry` field is `maxAttempts` (the loop runs `attempt = 1 … <= retry`), so `1` is exactly one attempt with no retries. Phase 1's minimal workflow has no place for the retry to land — re-launches would pile up tmux session/branch state and aggravate the same lifecycle race. The full workflow's retry budgets (spec) belong on `plan` / `implement-loop`. Default was 3, which is why the operator saw `[3/3]` on a failing run.
3. **`unhandledRejection` swallower** scoped to `dispatchEpic`'s lifetime — matches only `/Invalid or expired lock token for job/` and logs a notice to stderr. Anything else is re-raised via `queueMicrotask` so the runtime crashes the way it would have without the listener. Belt to the suspenders of (1) — bunqueue's worker can still race in edge cases (concurrent shutdown signals, in-flight retries) and the swallower keeps a benign internal race from killing an otherwise-completed dispatch.

**Why:** Encountered live during the manual end-to-end run on Epic #27. Run 1 completed (empty-prompt no-op turn), run 2 crashed mid-cleanup with the bunqueue lock-token throw before `dispatchEpic` could return. Without these, every dispatch whose `launch-and-drive` fails (which is most early-iteration runs) leaves the process in an inconsistent exit state.
**Evidence:** Full suite 105 pass; tests use the in-memory engine + stub adapter where the close-race doesn't manifest, but the same `dispatchEpic` path is exercised by `runDispatch` integration tests (including the EADDRINUSE failure path).

## `mm doctor` — Phase-1 preflight for external tools
**File(s):** `packages/cli/src/commands/doctor.ts`, `packages/dispatcher/src/tmux.ts`
**Date:** 2026-05-15

**Decision:** Ship a small `mm doctor` subcommand even though the build spec parks it in
Phase 11. The command shells `bun --version`, `tmux -V`, `claude --version`, `git
--version`, `gh --version`, `gh auth status`, parses each, and prints a one-line
pass/warn/fail per tool. Fail is anything missing or broken; warn is "installed but below
the threshold middle expects" — currently tmux < 3.5 (the version that supports
`extended-keys-format = csi-u`, needed for clean Shift-Tab / extended-key passthrough to
Claude when an operator attaches).
**Why:** The Phase 1 manual end-to-end test surfaced two pure-environment puzzles
(`extended-keys-format` in a < 3.5 `.tmux.conf`, the consequence of running on tmux 3.4)
that took longer to diagnose than the dispatch path's own bugs. A doctor command turns
those into one obvious `mm doctor` output. The full `mm doctor` (build-spec Phase 11) adds
schema validation, db row counts, recent retention runs — those are unaffected by this
Phase 1 stub and can extend the same checks list.
**Evidence:** `bun packages/cli/src/index.ts doctor` returns 0 on a healthy machine,
listing one check per tool. `parseTmuxVersion` / `tmuxVersionAtLeast` are unit-tested
(release versions, `next-` pre-releases, `3.5a` patches, garbage rejection). The doctor
test runs the happy path on this machine where the full toolchain is present.
