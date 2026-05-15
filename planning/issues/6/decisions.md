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
