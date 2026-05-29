# Decisions — Issue #64 (Operator polish)

## Implement sub-issues in dependency order, not numeric order
**File(s):** whole workstream
**Date:** 2026-05-29

**Decision:** Land #66 (retention) before #65 (doctor), then #67, then #68.
**Why:** Doctor's "recent retention-run status" reporting reads the `retention_runs` table, which retention creates. Docs (#68) go last so they describe shipped behavior, not the spec's intentions. Numeric order would force doctor to read a table that doesn't exist yet or stub it.
**Evidence:** #65 acceptance "reports SQLite row counts and recent retention-run status"; #66 acceptance "Retention runs are recorded so `mm doctor` can report recent retention status".

## doctor: dispatcher-reachable is warn-not-running, fail-only-when-wedged
**File(s):** `packages/cli/src/commands/doctor.ts` (`checkDispatcher`)
**Date:** 2026-05-29

**Decision:** `/health` reachable → pass; live pidfile but unreachable `/health` → fail; no/dead pidfile → warn.
**Why:** Operators routinely run `mm doctor` before `mm start`; a not-running dispatcher is normal, not an error (warn keeps exit 0). A *wedged* daemon (pid alive, port dead) is a real failure worth a non-zero exit. Distinguishing the two needs the pidfile, not just the probe.

## doctor: state-issue check is a self-test against the canonical fixture
**File(s):** `packages/cli/src/checks/state-issue.ts`
**Date:** 2026-05-29

**Decision:** Re-validate the parser by parse→render(byte-identical)→validate of `packages/state-issue`'s canonical fixture, using the fixture's own adapter set (`claude`, `codex`) — not the operator's configured adapters.
**Why:** The check verifies the *machinery* conforms to `schemas/state-issue.v1.md`, independent of whether a given operator configured codex. Using operator adapters would make a conforming fixture fail validate (rule 5) on a single-adapter install. Paths resolve from the module's location (like the module-index/skills checks) so it inspects middle's own source tree.

## doctor: retention/db check degrades, never spuriously fails
**File(s):** `packages/cli/src/commands/doctor.ts` (`checkDatabase`, `summarizeRetention`)
**Date:** 2026-05-29

**Decision:** No db file → warn; db below retention schema (< v6) → warn; unreadable db → fail; a *failed* last retention run → warn (surfaced as `FAILED`).
**Why:** Doctor must be safe to run any time. Only genuine corruption (can't open) is a hard fail; the rest are degraded-but-functional states. `existsSync` guards before `openDb` (which has `create:true`) so doctor never creates the db as a side effect.
