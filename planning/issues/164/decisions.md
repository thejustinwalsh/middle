# Decisions — Issue #164 (per-repo build-spec path)

## Spec path comes from the repo's `.middle/*.toml`, not the `repo_config.config_json` column
**File(s):** `packages/dispatcher/src/staleness-cron.ts`, `packages/core/src/config.ts`
**Date:** 2026-05-28

**Decision:** Resolve `spec_path` from each repo's merged config (`[staleness] spec_path`
in `.middle/config.toml`/`policy.toml`) via `@middle/core`'s `loadConfig`, not from the
reserved `config_json` column on the `repo_config` table.

**Why:** The issue names `.middle/config.toml` as the surface. Every other per-repo
setting the daemon reads (`[limits]`, `[recommender]`, `[docs]`) already flows through
`loadConfig`'s layered merge (defaults < global < committed `policy.toml` < local
`config.toml`), and main.ts already has the `loadConfigAt(repoPath)` pattern for exactly
this. Routing `spec_path` the same way gets precedence, the committed-vs-local split, and
tilde expansion for free, and keeps the `config_json` column free for its intended later
sync work. A DB-column approach would have been a second, divergent config path.

## `globalConfigPath` deps seam instead of an injectable `resolveSpecPath`
**File(s):** `packages/dispatcher/src/staleness-cron.ts:48`
**Date:** 2026-05-28

**Decision:** `StalenessCronDeps` gains one knob — `globalConfigPath` — threaded into the
per-repo `loadConfig({ globalPath, repoPath })`. The default resolver (reading real
`.middle/config.toml` files off the checkout) is always used; tests point `globalConfigPath`
at a non-existent scratch file to stay hermetic.

**Why:** The integration criterion (AC2) demands the *real* path-resolution exercised end to
end ("the real path, not just a unit of the config loader"). Injecting a fake resolver would
have let the test bypass the very code under test. Threading only the global path keeps the
production resolver in the test loop while making it deterministic regardless of the host's
`~/.middle/config.toml`. It also mirrors every other per-repo load in main.ts, which already
passes `process.env.MIDDLE_CONFIG` as `globalPath`.

**Evidence:** `packages/dispatcher/src/main.ts` lines 248–252, 425–427, 692–694 all load
per-repo config with `globalPath: process.env.MIDDLE_CONFIG`.

## Per-repo spec-path resolution runs inside the per-repo guard
**File(s):** `packages/dispatcher/src/staleness-cron.ts`
**Date:** 2026-05-28

**Decision:** `resolveSpecPath` is called inside the existing per-repo `try`, not once
before the loop.

**Why:** `loadConfig` parses TOML, which can throw on a malformed `config.toml`. A throw for
one repo must log as that repo's failure and let the sweep continue — the same isolation the
spec read and `reconcileStaleness` already get. Resolving outside the loop would have let one
repo's broken config abort the whole pass.

## Removed the old `specPath` deps field rather than keeping both
**File(s):** `packages/dispatcher/src/staleness-cron.ts`
**Date:** 2026-05-28

**Decision:** Dropped `StalenessCronDeps.specPath` (a global override) in favor of per-repo
resolution + `globalConfigPath`.

**Why:** No caller passed `specPath` (main.ts never did; the cron tests never did) — it was
a vestigial test-injection knob. Keeping both a global `specPath` and per-repo resolution
would have created an ambiguous precedence with no caller to justify it. `reconcileStaleness`
keeps its own `specPath` arg (that's the algorithm input, fed the resolved value per repo).

## Constrain a configured spec_path to the repo checkout (review round 1)
**File(s):** `packages/dispatcher/src/staleness-cron.ts:56`
**Date:** 2026-05-28

**Decision:** `resolveSpecPath` validates the configured `[staleness] spec_path` against the
checkout and **throws** if it escapes — an absolute path, or one that climbs out via `..`.
The boundary test matches the `..` path segment exactly (`rel === ".."` or `rel.startsWith(".." + sep)`),
not a naive `startsWith("..")`, so a literal filename segment like `..foo` is still allowed.
Validation joins with the same `join(checkoutPath, specPath)` that `readSpec` reads with, so
there is no validate-vs-read divergence.

**Why:** CodeRabbit (PR #176, Major) flagged that `spec_path` is read off disk via
`readFileSync(join(checkoutPath, specPath))` with no checkout bound, so a committed `policy.toml`
or local `config.toml` could read files outside the repo (and a matched line is quoted into a
filed reconcile-task body — a disclosure path). The field is documented repo-relative and the
config mapper does **not** tilde-expand it, so an absolute value is never intended; rejecting is
the contract. Throwing (rather than silently falling back to the default) reuses the existing
per-repo guard: one repo's bad spec_path logs as that repo's failure and the sweep continues —
the same isolation a malformed `config.toml` already gets. Symlink TOCTOU (a spec path inside the
checkout that symlinks out) is a different, filesystem-level class and out of this fix's blast radius.

**Evidence:** Four added tests in `packages/dispatcher/test/staleness-cron.test.ts` — a `..`
escape and a deeper `../../` escape (both with an out-of-checkout drift file that is provably
never read: `closed===0`, `created===[]`, repo logged as "pass failed"), an absolute path
rejected, and the `..foo`-segment regression guard that a non-escaping `..`-prefixed name is
still read. Full suite: 534 pass / 0 fail; typecheck + lint clean.
