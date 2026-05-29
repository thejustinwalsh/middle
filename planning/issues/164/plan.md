# Issue #164: feat(staleness): make the build-spec path configurable per repo

**Link:** https://github.com/thejustinwalsh/middle/issues/164
**Branch:** middle-issue-164

## Goal
Let each managed repo declare where its build spec lives (`[staleness] spec_path`
in `.middle/config.toml`/`policy.toml`), so the anti-staleness drift check works
for repos whose spec isn't at middle's own hardcoded default — instead of silently
getting no drift detection.

## Approach
- Add a `[staleness]` section to `@middle/core`'s config schema (`StalenessSettings
  = { specPath?: string }`), with a strict-but-optional mapper, and surface it on
  `MiddleConfig`. The committed `policy.toml` template gains the section so it's
  the inverse of the mapper (the project's config-template convention).
- `runStalenessCronPass` resolves the spec path **per managed repo** by loading
  that repo's merged config (defaults < global < `policy.toml` < `config.toml`) and
  reading `[staleness] spec_path`, falling back to the existing `DEFAULT_SPEC_PATH`.
  The cron already iterates managed repos with their checkout paths — this is the
  natural seam.
- Thread the daemon's global config path (`process.env.MIDDLE_CONFIG`) into the
  cron deps so the per-repo loads see the same global layer `mm start` booted with,
  and so tests can point it at a scratch file (hermetic).
- Per-repo config resolution happens inside the existing per-repo `try` so a
  malformed `config.toml` for one repo logs-and-continues instead of crashing the
  whole sweep.

## Phases
(Standalone issue — one workstream / one PR. Logical implementation steps:)
1. Core config — add `[staleness]` schema + mapper + export; TDD in `@middle/core`.
2. Cron resolution — per-repo `spec_path` resolution in `runStalenessCronPass` +
   `globalConfigPath` deps seam; update existing cron unit tests to be hermetic.
3. Integration test — boot the real cron pass over a managed repo whose
   `config.toml` points `spec_path` at a non-default location; assert drift is
   detected through the real resolved path. Plus fallback coverage: no config →
   default path; no spec file → reconcile still runs, no drift.
4. Wire `mm start` — main.ts passes `globalConfigPath` to `startStalenessCron`.
5. Template + docs — `[staleness]` block in the committed `policy.toml` template.

## Files likely to change
- `packages/core/src/config.ts` — `StalenessSettings`, `mapStaleness`, `MiddleConfig.staleness`.
- `packages/core/src/index.ts` — export `StalenessSettings`.
- `packages/dispatcher/src/staleness-cron.ts` — per-repo spec-path resolution + `globalConfigPath`.
- `packages/dispatcher/src/main.ts` — pass `globalConfigPath` at the cron start site.
- `packages/cli/src/bootstrap/config-template.ts` — `[staleness]` in `policy.toml`.
- Tests: `packages/core/test/config.test.ts`, `packages/dispatcher/test/staleness-cron.test.ts`.

## Out of scope
- A `config_json`-column-backed per-repo config (the `repo_config` table's reserved
  column) — config lives in the repo's `.middle/*.toml`, consistent with every other
  per-repo setting the daemon reads.
- Changing the drift-detection algorithm itself (`staleness.ts`) — only where its
  spec path comes from.

## Open questions
- None blocking. Spec path precedence follows the established `loadConfig` layering;
  fallback is the existing `DEFAULT_SPEC_PATH`.
