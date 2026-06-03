/**
 * @packageDocumentation
 * @module @middle/cli/bootstrap
 *
 * The internals behind `mm init` / `mm uninit`: stamping skills, hooks, config,
 * and the state issue into (and out of) a target repo.
 *
 * Public surface:
 * - `initRepo` / `uninitRepo` — the bootstrap + teardown entry points
 * - `realDeps` — the production dependency bundle (fs + git + gh)
 * - `buildInitialStateIssueBody` — state-issue content template
 * - `renderRepoPolicy` / `renderLocalConfig` — the committed-policy / local-cache templates
 * - `writeFileStoreScaffold` + `render*` — file-mode Epic-store scaffolding (#194)
 * - bootstrap types + constants (`BOOTSTRAP_VERSION`, `STATE_ISSUE_TITLE`, …)
 *
 * Where things live:
 * - `init.ts` / `uninit.ts` — the orchestration
 * - `deps.ts` — the injectable side-effect bundle (keeps init testable)
 * - `assets.ts`, `hook-config.ts`, `gitignore.ts` — what gets stamped
 * - `skills-sync.ts` — the canonical↔mirror skills invariant
 * - `state-issue-body.ts`, `config-template.ts` — generated content
 * - `file-store.ts` — file-mode Epic-store scaffold (README/.keep/state.md/toml)
 * - `types.ts` — shared bootstrap types + constants
 *
 * Gotchas:
 * - Skills must stay byte-identical canonical↔mirror; see this dir's CLAUDE.md.
 * - Config is split (issue #103): `policy.toml` is committed/shared, `config.toml`
 *   is the gitignored local cache. `mm init` writes policy.toml only when absent.
 *
 * claude-md: true
 */
export { initRepo } from "./init.ts";
export { uninitRepo } from "./uninit.ts";
export { realDeps } from "./deps.ts";
export { buildInitialStateIssueBody } from "./state-issue-body.ts";
export { renderLocalConfig, renderRepoPolicy } from "./config-template.ts";
export {
  FILE_EPICS_DIR,
  FILE_STATE_FILE,
  renderEmptyStateBody,
  renderEpicsReadme,
  renderEpicStoreToml,
  writeFileStoreScaffold,
} from "./file-store.ts";
export type {
  BootstrapDeps,
  BootstrapOptions,
  EpicStoreMode,
  GithubGateway,
  InitResult,
  RepoInfo,
  UninitResult,
} from "./types.ts";
export { BOOTSTRAP_VERSION, STATE_ISSUE_TITLE, STATE_LABEL, STATE_LABEL_COLOR } from "./types.ts";
