# Issue #107: mm init: stamp the state-issue schema into target repos

**Link:** https://github.com/thejustinwalsh/middle/issues/107
**Branch:** middle-issue-107

## Goal
The recommender must find `state-issue.v1.md` when run against *any* target repo,
not just middle's own checkout. Today both readers resolve
`<repoPath>/schemas/state-issue.v1.md`, which only exists in middle's repo.

## Approach
The issue offers two fixes: (a) `mm init` copies the schema into each target repo,
or (b) resolve `schema_path` from the installed `@middle/state-issue` package so
no per-repo copy is needed. **We take (b).** Rationale (see decisions.md):
- Root CLAUDE.md's state-issue contract makes `schemas/state-issue.v1.md` the
  single source of truth. Option (a) stamps N copies that drift from it — the
  same "two-copies invariant" burden skills carry, multiplied per repo, for a
  file the target repo's collaborators never need (it's middle-internal dispatch
  machinery, unlike skills which the dispatched coding agent reads in-repo).
- The repo already has the exact precedent: `skills-sync.ts` resolves middle-tree
  assets from `import.meta.dir` (stable regardless of caller cwd). We mirror it.
- The issue's own wording ("so no per-repo copy is needed") leans toward (b).

## Phases
1. Resolve-from-package — add `STATE_ISSUE_SCHEMA_PATH` to `@middle/state-issue`,
   point both recommender readers at it, drop the dead per-repo fixture, test.

(Standalone issue → one-phase Epic.)

## Files likely to change
- `packages/state-issue/src/schema-path.ts` — NEW: `STATE_ISSUE_SCHEMA_PATH`,
  resolved from `import.meta.dir` (repo-root `schemas/state-issue.v1.md`).
- `packages/state-issue/src/index.ts` — export it; update module-index frontmatter.
- `packages/dispatcher/src/recommender-run.ts` — use the resolver; reword the
  existsSync guard (a miss is now a broken middle install, not a repo problem).
- `packages/dispatcher/src/main.ts` — use the resolver in `resolveRunSettings`.
- `packages/state-issue/test/schema-path.test.ts` — NEW: resolver points at the
  real, existing canonical schema.
- `packages/dispatcher/test/recommender-run.test.ts` — assert the resolved
  schemaPath is the middle schema, independent of repoPath.
- `packages/cli/test/run-recommender.test.ts` — remove the dead per-repo schema
  fixture (the thin client never reads it).

## Out of scope
- Changing `mm init`'s stamping set (option (a) — explicitly rejected).
- Moving the schema file into the package dir / changing its repo-root location.
- The recommender prompt format or the schema content itself.

## Open questions
- None. The issue presents both options; (b) is chosen on documented criteria.
