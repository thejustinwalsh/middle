import { BOOTSTRAP_VERSION, STATE_LABEL, type RepoInfo } from "./types.ts";

export type LocalConfigValues = {
  stateIssueNumber: number;
  installedAt: string;
};

/**
 * Render `<repo>/.middle/policy.toml` — the **committed**, shareable repo policy
 * (issue #103). Holds `[repo]` identity, `[limits]`, `[recommender]`, and the
 * `[docs]` harvester block, all matching the build spec's "Per-repo config"
 * defaults verbatim (auto_dispatch and docs `write` default OFF — opt-in). A team
 * edits this file in version control to agree on e.g. `complexity_ceiling`.
 *
 * The keys here are the keys `@middle/core`'s `loadConfig` reads back, so this
 * template is the inverse of that mapper. Volatile/per-machine fields live in the
 * gitignored local cache instead — see {@link renderLocalConfig}.
 */
export function renderRepoPolicy(info: RepoInfo): string {
  return `# middle repo policy — COMMITTED and shared across contributors (issue #103).
# Volatile/per-machine fields live in the gitignored .middle/config.toml cache.
[repo]
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

[docs]
enabled = true
interval_minutes = 1440
adapter = "claude"
write = false
`;
}

/**
 * Render `<repo>/.middle/config.toml` — the **gitignored**, per-machine local
 * operational cache (issue #103). Holds only volatile fields: the `[state_issue]`
 * number (GitHub remains its source of truth, per #102) and `[bootstrap]`
 * install metadata. `loadConfig` merges this on top of the committed policy, so
 * a value set here overrides the shared policy for this machine only.
 */
export function renderLocalConfig(v: LocalConfigValues): string {
  return `# middle local cache — GITIGNORED, per-machine (issue #103).
# Shared policy lives in the committed .middle/policy.toml.
[state_issue]
number = ${v.stateIssueNumber}
label = "${STATE_LABEL}"

[bootstrap]
version = ${BOOTSTRAP_VERSION}
installed_at = "${v.installedAt}"
`;
}
