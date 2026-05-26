# Issue #103: Share repo policy from config.toml across contributors (split volatile fields)

**Link:** https://github.com/thejustinwalsh/middle/issues/103
**Branch:** middle-issue-103

## Goal
Let contributors commit shared repo policy (limits, recommender, docs, repo identity) in-repo while keeping per-machine/volatile fields (state-issue number, bootstrap timestamp) out of version control — so a team can agree on `complexity_ceiling` etc. and a fresh clone reads the committed policy before `mm init` ever runs.

## Approach (decision: committed policy file + local operational cache)
The repo already commits one file inside the otherwise-gitignored `.middle/` — `verify.toml`, via `.middle/*` + `!.middle/verify.toml`. We follow that exact precedent rather than un-ignoring `config.toml` minus volatile fields (which would commit a file `mm init` rewrites with volatile data → churn). So:

- **`.middle/policy.toml` (committed)** — shareable policy: `[repo]`, `[limits]`, `[recommender]`, `[docs]`.
- **`.middle/config.toml` (gitignored, local operational cache)** — volatile/per-machine: `[state_issue]` (number + label), `[bootstrap]` (version + installed_at). Also where `mm config` writes operator-local overrides.
- **Merge precedence:** `GLOBAL_DEFAULTS` < global file < **policy.toml** < **local config.toml** (most-local wins, matching the existing "per-repo overrides global" direction). Local can override committed policy on one machine without touching the shared file; absent a local override, the team's committed policy value holds for everyone.
- `loadConfig` derives `policy.toml` as the sibling of the `repoPath` it already receives → **zero call-site churn** at the 8+ existing call sites.
- `mm init` writes `policy.toml` only when it's **absent** (never clobbers committed team edits on re-init/migrate); the local cache keeps its existing write rules.

## Phases
1. **core/loadConfig** — insert the committed-policy layer between global and local in the merge; derive sibling `policy.toml` from `repoPath` (overridable for tests). Tests for the new precedence + fresh-clone-policy-without-local-cache case.
2. **bootstrap split** — split `renderRepoConfig` into `renderRepoPolicy` (committed) + `renderLocalConfig` (volatile); `initRepo` writes both, writing `policy.toml` only if absent; update `addMiddleIgnore`/`removeMiddleIgnore` to the `.middle/*` + `!.middle/policy.toml` (+`!.middle/verify.toml`) glob-exception form so a committed `policy.toml` survives. Update bootstrap/uninit tests.
3. **dogfood + docs** — commit this repo's own `.middle/policy.toml` and add the `!.middle/policy.toml` exception to the repo's `.gitignore`; update the bootstrap module-index frontmatter / TSDoc for the two-file layout.

## Files likely to change
- `packages/core/src/config.ts` — add policy layer + sibling derivation to `loadConfig`.
- `packages/cli/src/bootstrap/config-template.ts` — `renderRepoPolicy` + `renderLocalConfig`.
- `packages/cli/src/bootstrap/init.ts` — write both files; never clobber committed policy.
- `packages/cli/src/bootstrap/gitignore.ts` — glob-exception ignore form + matching removal.
- `packages/cli/src/bootstrap/uninit.ts` — ensure cleanup covers committed policy + new ignore lines.
- `.middle/policy.toml` (new, committed) + `.gitignore` (repo's own).
- Tests: `packages/core/test/config.test.ts`, `packages/cli/test/bootstrap-init.test.ts`, `packages/cli/test/config.test.ts`.

## Out of scope
- The state-issue dedup itself (#102 — prerequisite, already closed).
- Reworking `mm config`'s settable-key table (it keeps writing to the local cache, which now overrides policy by precedence — no routing change needed for v1's single `auto_dispatch` key).

## Open questions
- None blocking. Precedence (local-wins) and the committed-file approach are both decided by the `verify.toml` precedent + the issue's own "local operational cache" framing; recorded in `decisions.md`.
