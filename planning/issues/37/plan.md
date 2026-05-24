# Issue #37: Mechanical verification gates (Phase 6)

**Link:** https://github.com/thejustinwalsh/middle/issues/37
**Branch:** middle-issue-37

## Goal
After an agent ticks a phase's PR Status checkbox, the dispatcher runs that phase's declared verification gates inside the worktree, posts the results to the PR as collapsed `<details>` evidence, and reverts the checkbox if any gate fails. This is the Phase 6 build sequence (#30–33) and the gate-runner half of the Phase 4 checkbox-revert seam (`runGates`) that already exists.

## Approach
- The Phase 4 checkbox-revert reconciler (`packages/dispatcher/src/gates/checkbox-revert.ts`) already detects `[ ] → [x]` transitions and takes an injected `runGates(subIssue) => GateRunResult`. Phase 6 fills that seam end to end; we do **not** rebuild detection/revert.
- Per-repo gates are declared in `<worktree>/.middle/verify.toml`, mirroring the existing `<repo>/.middle/config.toml` convention (operator-installed, local-only). The schema is documented in a committed `schemas/verify.v1.md` (mirroring `schemas/state-issue.v1.md`).
- Gates are addressable per phase: each gate optionally scopes to a set of sub-issue numbers via a `phases` key; a gate with no `phases` applies to every phase. `gatesForPhase(config, subIssue)` resolves the set the reconciler runs.
- The runner executes gates with `Bun.spawn` (the established `runGit`/`run` pattern), in declared order, capturing exit code / stdout / stderr, bounded by a per-gate timeout.
- Evidence is posted as a single PR comment keyed by an HTML marker (`<!-- middle:gate-evidence:phase-N -->`) so re-runs update in place rather than spam.
- The wiring layer (`runGates`) composes config + runner + evidence and adapts the rich per-gate results down to the reconciler's `{ ok } | { ok:false, failedGate }`.
- TDD throughout (`test-driven-development` skill): each sub-issue's acceptance criteria become tests written first.

## Phases (one per sub-issue)
1. **#38** — `verify.toml` framework: schema doc + loader + validation + per-phase addressing. Tests: valid / malformed / missing.
2. **#39** — Gate runner: execute gates in the worktree, capture exit/stdout/stderr, ordered run + aggregate, per-gate timeout. Tests: passing / failing / timing-out against a scratch worktree.
3. **#40** — PR evidence posting: pass/fail summary + collapsed `<details>` full output, idempotent upsert by marker. Test: mixed pass/fail structure.
4. **#41** — Wire into checkbox-revert: `runGates` factory composing #38+#39+#40; failing gate reverts the box, passing keeps it + evidence reflects pass. End-to-end test.

## Files likely to change
- `schemas/verify.v1.md` — NEW; committed schema source of truth.
- `packages/dispatcher/src/gates/verify-config.ts` — NEW; types, `loadVerifyConfig`, `gatesForPhase`, validation.
- `packages/dispatcher/src/gates/gate-runner.ts` — NEW; `runGate` / `runGates`, timeout, capture.
- `packages/dispatcher/src/gates/gate-evidence.ts` — NEW; render + `upsertEvidenceComment`.
- `packages/dispatcher/src/gates/verify.ts` — NEW; `makeRunPhaseGates` factory (the reconciler's `runGates`).
- `packages/dispatcher/src/github.ts` — extend `GitHubGateway` with comment id/edit so evidence can upsert.
- `packages/dispatcher/package.json` — add `smol-toml` dep.
- `packages/dispatcher/test/gates/{verify-config,gate-runner,gate-evidence,verify}.test.ts` — NEW.

## Out of scope
- The "after every push" cron/trigger wiring that *invokes* the reconciler (build spec notes reconciler crons land in their own Phase 2+ wiring; the reconciler seam already exists and is what we fill).
- `mm init` installing `verify.toml` into the worktree (init-time concern; we define + load + validate it).
- CodexAdapter, dashboard, recommender (later phases).

## Open questions
- None blocking. `verify.toml` path follows the established `.middle/config.toml` convention; schema documented in committed `schemas/` to satisfy "defined and documented" without fighting the `.middle/` gitignore.
