export { initRepo } from "./init.ts";
export { uninitRepo } from "./uninit.ts";
export { realDeps } from "./deps.ts";
export { buildInitialStateIssueBody } from "./state-issue-body.ts";
export { renderRepoConfig } from "./config-template.ts";
export type {
  BootstrapDeps,
  BootstrapOptions,
  GithubGateway,
  InitResult,
  RepoInfo,
  UninitResult,
} from "./types.ts";
export {
  BOOTSTRAP_VERSION,
  STATE_ISSUE_TITLE,
  STATE_LABEL,
  STATE_LABEL_COLOR,
} from "./types.ts";
