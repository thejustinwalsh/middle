# Issue #1: Bootstrap repo and state-issue parser foundation

**Link:** https://github.com/thejustinwalsh/middle/issues/1
**Branch:** worktree-1-bootstrap-repo-state-issue-parser

## Goal
Stand up the Bun TypeScript monorepo and ship the state-issue v1 parser/renderer/validate
contract — the keystone every downstream phase depends on — with a schema doc as source of
truth, a round-trip fuzz test, and a hand-crafted fixture.

## Approach
- One Epic = one branch = one PR. All 5 sub-issues land here.
- Sequence by the sub-issue dependency graph: #2 → #31 → #3 → (#4, #5).
- The schema doc (`schemas/state-issue.v1.md`) is the source of truth; parser conforms to it.
- TDD for the parser/renderer/validate: schema doc + hand fixture drive the tests.
- Round-trip byte-identity is the load-bearing invariant — fuzz it hard (≥10k iterations).

## Phases
1. **#2 Monorepo** — `bun init`, workspace root, scaffold `packages/*` per spec Repo layout, root `tsconfig.json`, install stack, `bun test` runs clean.
2. **#31 Schema doc** — extract the full State-issue v1 schema from the build spec into `schemas/state-issue.v1.md`.
3. **#3 Parser** — `schema.v1.ts` types, `parseStateIssue`, `renderStateIssue`, `validate`, conforming to the schema doc; markers respected.
4. **#4 Fuzz test** — random valid `ParsedState` generator across all 7 sections incl. empty states; assert `render(parse(render(s)))` byte-identical; ≥10k iterations.
5. **#5 Fixture** — hand-crafted schema-conforming body under `packages/state-issue/test/`; parses, validates, round-trips.

## Files likely to change
- `package.json`, `tsconfig.json`, `bun.lock` — workspace root
- `packages/*/package.json` + `src/` stubs — scaffolded per Repo layout
- `schemas/state-issue.v1.md` — the schema doc
- `packages/core/src/config.ts` — minimal `RepoConfig` type (needed by `validate`)
- `packages/state-issue/src/{schema.v1,parser,renderer,validate}.ts`
- `packages/state-issue/test/` — fuzz test + hand-crafted fixture

## Out of scope
- Any package source beyond `state-issue` (and the minimal `RepoConfig` type `validate` needs)
- CI configuration
- `.middle/` self-bootstrap (Phase 3 of the build spec)
- `mm doctor` re-validation wiring (Phase 11)

## Open questions
- None blocking. `RepoConfig` is referenced by `validate()` but `packages/core` isn't
  implemented until Phase 1 of the build spec — resolving by adding only the minimal
  type shape (`adapters` names) to `packages/core/src/config.ts`, not the loader.
