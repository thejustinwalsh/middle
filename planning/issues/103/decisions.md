# Decisions — Issue #103

## Committed policy file (not un-ignoring config.toml)
**File(s):** `.middle/policy.toml`, `packages/cli/src/bootstrap/gitignore.ts`
**Date:** 2026-05-26

**Decision:** Split policy into a new committed `.middle/policy.toml`, leaving the existing `.middle/config.toml` gitignored as the local operational cache. Reject the alternative of un-ignoring `config.toml` minus volatile fields.

**Why:** The repo already commits exactly one file inside the otherwise-ignored `.middle/` — `verify.toml`, via `.middle/*` + `!.middle/verify.toml`. A second committed policy file is the same, proven pattern. Un-ignoring `config.toml` instead means committing a file `mm init` rewrites with volatile data (`state_issue.number`, `installed_at`) — every re-init would churn the committed file or require fragile field-stripping. A clean split keeps volatile data in a file git never sees.

**Evidence:** `.gitignore` lines 11-12 (`!.middle/verify.toml`); `mm init`'s `renderRepoConfig` writes volatile fields inline.

## Merge precedence: local cache wins over committed policy
**File(s):** `packages/core/src/config.ts`
**Date:** 2026-05-26

**Decision:** Merge order is `GLOBAL_DEFAULTS` < global file < `policy.toml` < local `config.toml`. The local operational cache overrides committed policy on a colliding key.

**Why:** Matches the existing precedence direction (the doc comment and tests already establish "per-repo overrides global" — most-local wins). The local cache is the operator's machine-local layer; letting it override gives a clean escape hatch (e.g. bump `max_concurrent` on a beefy box) without editing the shared file. Crucially, the default case is unaffected: a contributor with no local override gets the team's committed policy value. `mm config` keeps writing to the local cache, so it stays a local-operator action by construction — no routing change needed.

**Evidence:** `loadConfig`'s existing `deepMerge(globalRaw, readToml(repoPath))` and the `per-repo values override global` test.

## loadConfig derives policy.toml as repoPath's sibling
**File(s):** `packages/core/src/config.ts`
**Date:** 2026-05-26

**Decision:** `loadConfig` derives the policy path as `<dir of repoPath>/policy.toml` rather than adding a required `repoPolicyPath` to every call site. An optional `repoPolicyPath` override exists for tests.

**Why:** All 8+ call sites already pass `repoPath: join(checkout, ".middle", "config.toml")`. The sibling derivation makes them pick up policy with zero churn, and a fresh clone (committed `policy.toml`, no local `config.toml` yet) reads policy correctly because the absent local file just contributes `{}`.

**Evidence:** Call sites in `packages/dispatcher/src/main.ts`, `packages/cli/src/commands/docs.ts`, etc.
