# Issue #64: Operator polish (Epic)

**Link:** https://github.com/thejustinwalsh/middle/issues/64
**Branch:** middle-issue-64

## Goal
Ship Phase 11 operator polish so a new user can clone middle, `bun install`, `mm start`, `mm init <repo>`, and reach a working dispatch within 5 minutes: a real `mm doctor` health check, retention crons that bound operational state, backup/reset-db scripts, and the README + `docs/` set.

## Approach
- The Epic's four open sub-issues are the phases. One branch, one PR, gates between phases.
- **Implementation order follows the dependency edge, not the issue numbers.** `mm doctor` (#65) must report "recent retention-run status", which only exists once the `retention_runs` table does. So **#66 (retention) lands first**, then #65 (doctor), then #67 (scripts), then #68 (docs — written last so they describe shipped behavior, not intentions).
- New checks and the retention pass are built as **pure functions with injected seams** (db handle, config, `fetch`, fixture body), matching the existing `recommender-cron` / doctor style, so each is unit-testable without a live dispatcher.
- Retention touches **only** middle's SQLite. GitHub is the system of record — never backed up, never pruned by middle.

## Phases (one per sub-issue)
1. **#66 — Retention crons.** Migration `006`: add `workflows.archived_at` + a `retention_runs` table. `retention.ts` (`runRetentionPass`) + `retention-cron.ts` (`startRetentionCron`), mirroring `recommender-cron.ts`. Wire into `main.ts` startup + shutdown. Daily cron: delete `events` older than 14d; archive completed `workflows` older than 30d (drop their events, preserve row + `meta_json`/config snapshot + final state); record each run in `retention_runs`. Tests cover both cutoffs.
2. **#65 — `mm doctor` full health check.** Extend `doctor.ts` with: config-files-parse check (`loadConfig`), dispatcher-reachable check (`GET /health`), state-issue parser re-validation (parse → render byte-identical round-trip + `validate()` of the canonical fixture, with schema-version assertion against `schemas/state-issue.v1.md`), and SQLite row counts + most-recent retention-run status. Any check failing → non-zero exit. New pure helpers get unit tests.
3. **#67 — Backup + reset-db scripts.** `scripts/backup.sh` (SQLite DB via `.backup` + config files → timestamped restorable archive) and `scripts/reset-db.sh` (nuke `~/.middle/db.sqlite3` + WAL/SHM, never touch GitHub). Both: clear output, confirm-before-destroy, documented. Restore yields a working dispatcher.
4. **#68 — README + docs/.** Refresh README quickstart against shipped behavior; author `docs/architecture.md`, `docs/adapters.md`, `docs/bootstrap.md`, `docs/skill-enforcement.md`, `docs/operator.md` (`docs/dogfooding.md` already exists). Verify the 5-minute quickstart end to end. Follow the `documenting-the-repo` skill (Diátaxis, repo voice).

## Files likely to change
- `packages/dispatcher/src/db/migrations/006_retention.sql` — new: `archived_at` column + `retention_runs` table
- `packages/dispatcher/src/retention.ts`, `retention-cron.ts` — new: pass + cron
- `packages/dispatcher/src/main.ts` — register/stop the retention cron
- `packages/dispatcher/test/retention*.test.ts` — cutoff tests
- `packages/cli/src/commands/doctor.ts` — new checks (config, dispatcher, state-issue, db/retention)
- `packages/cli/test/doctor.test.ts` — unit tests for new pure helpers
- `scripts/backup.sh`, `scripts/reset-db.sh` — new
- `README.md`, `docs/architecture.md|adapters.md|bootstrap.md|skill-enforcement.md|operator.md` — docs

## Out of scope
- The skill-sync pre-commit hook (delivered with the Phase 3 skills task).
- Backing up any GitHub data — GitHub is the system of record.
- CodexAdapter behavior (Phase 10, #60 — closed); docs describe it as roadmap where not shipped.

## Open questions
- None blocking. Retention defaults (14d events / 30d workflows) and daily cadence are fixed by the spec.
