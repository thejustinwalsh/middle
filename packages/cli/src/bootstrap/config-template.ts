import { BOOTSTRAP_VERSION, STATE_LABEL, type RepoInfo } from "./types.ts";

export type RepoConfigValues = {
  info: RepoInfo;
  stateIssueNumber: number;
  installedAt: string;
};

/**
 * Render `<repo>/.middle/config.toml` from the build spec's "Per-repo config"
 * block. The `[repo]` identity and `[state_issue] number` / `[bootstrap]
 * installed_at` are filled per-target; the `[limits]` and `[recommender]`
 * defaults match the spec verbatim (auto_dispatch defaults OFF — opt-in).
 *
 * The keys here are the keys `@middle/core`'s `loadConfig` reads back, so this
 * template is the inverse of that mapper.
 */
export function renderRepoConfig(v: RepoConfigValues): string {
  const { info } = v;
  return `[repo]
owner = "${info.owner}"
name = "${info.name}"
default_branch = "${info.defaultBranch}"
pr_mode = "single"

[limits]
max_concurrent = 3
max_concurrent_per_adapter = { claude = 2, codex = 1 }
complexity_ceiling = 3

[recommender]
enabled = true
interval_minutes = 15
adapter = "claude"
auto_dispatch = false

[state_issue]
number = ${v.stateIssueNumber}
label = "${STATE_LABEL}"

[bootstrap]
version = ${BOOTSTRAP_VERSION}
installed_at = "${v.installedAt}"
`;
}
