# Decisions — Issue #64 (Operator polish)

## Implement sub-issues in dependency order, not numeric order
**File(s):** whole workstream
**Date:** 2026-05-29

**Decision:** Land #66 (retention) before #65 (doctor), then #67, then #68.
**Why:** Doctor's "recent retention-run status" reporting reads the `retention_runs` table, which retention creates. Docs (#68) go last so they describe shipped behavior, not the spec's intentions. Numeric order would force doctor to read a table that doesn't exist yet or stub it.
**Evidence:** #65 acceptance "reports SQLite row counts and recent retention-run status"; #66 acceptance "Retention runs are recorded so `mm doctor` can report recent retention status".
