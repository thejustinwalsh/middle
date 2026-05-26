# Decisions — Issue #107

## Resolve schema from the package, not per-repo stamping
**File(s):** `packages/state-issue/src/schema-path.ts`, `packages/dispatcher/src/recommender-run.ts:122`, `packages/dispatcher/src/main.ts:578`
**Date:** 2026-05-26

**Decision:** Implement the issue's option (b) — resolve `schema_path` from the
`@middle/state-issue` package — and reject option (a) (`mm init` copies the
schema into each target repo).

**Why:**
- **Single source of truth.** Root CLAUDE.md's state-issue contract declares
  `schemas/state-issue.v1.md` authoritative. Option (a) creates one copy per
  bootstrapped repo, each able to drift from the source — the precise failure
  the "source of truth" rule exists to prevent. It would also need a per-repo
  re-sync/drift gate (skills already carry this "two-copies invariant"; (a)
  multiplies it by every target repo).
- **The schema is middle-internal.** Skills are stamped because the dispatched
  *coding agent runs in the target repo* and the repo's collaborators share them.
  The state-issue schema is dispatch machinery the recommender agent reads; the
  target repo and its collaborators never need it in their tree.
- **Established precedent.** `packages/cli/src/bootstrap/skills-sync.ts` already
  resolves middle-tree assets from `import.meta.dir` ("stable regardless of the
  caller's cwd"). `STATE_ISSUE_SCHEMA_PATH` mirrors that pattern exactly.
- **The issue leans this way.** Its phrasing "resolve `schema_path` from the
  installed `@middle/state-issue` package so no per-repo copy is needed" signals
  (b) as the cleaner fix.

**Evidence:** `skills-sync.ts:21-23` (the `import.meta.dir` precedent + rationale
comment); root CLAUDE.md "state-issue contract"; issue #107 body.

## Reword the existsSync guard as a packaging-integrity check
**File(s):** `packages/dispatcher/src/recommender-run.ts:123-127`
**Date:** 2026-05-26

**Decision:** Keep the `existsSync(schemaPath)` guard but reword its error: a miss
is now a broken/partial middle installation, not a per-repo "Phase 7 runs against
middle's own repo" condition.

**Why:** Post-fix the path points into the middle installation, which always ships
the schema. A miss therefore means the install is corrupt — a different failure
mode that deserves a different, actionable message. The cheap guard stays so the
failure surfaces here with a clear cause instead of as a confusing agent-side
`cat: no such file` mid-run.

## Drop the dead per-repo schema fixture in run-recommender.test.ts
**File(s):** `packages/cli/test/run-recommender.test.ts:47-49`
**Date:** 2026-05-26

**Decision:** Remove the fixture that wrote `<repo>/schemas/state-issue.v1.md`.

**Why:** `runRecommender` is a thin daemon client (it never calls
`resolveRecommenderOptions`; validation happens daemon-side). The fixture was
never read even before this change; after option (b) it is doubly misleading
because no reader looks in the target repo anymore.
