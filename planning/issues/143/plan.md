# Epic #143: Self-auditing systems — integration-verified requirements + freshness

**Link:** https://github.com/thejustinwalsh/middle/issues/143
**Branch:** middle-issue-143

## Goal
Close middle's recurring "green tests as the artifact" failure mode by making the
*requirements contract* demand integration into the running product, enforcing that
contract where work lands (PR-ready), and keeping issues + the build spec from going
stale. Three coordinated self-auditing systems, built (1) → (2) → (3).

## Approach
- **Shared rubric in `@middle/core`.** The "integration criterion" predicate is the
  keystone both the issue auditor (#144) and the PR-ready gate (#145) consume. One
  source of truth: a criterion is an *integration criterion* iff it names a
  product-wiring signal (mounted/served/invoked/reachable) **and** a real-path test
  signal (integration/smoke/e2e exercising the live path). "Unit tests pass" fails.
- **#144 audits where issues are filed** — an `mm audit-issues` command + a
  `verifying-requirements` skill; a `creating-github-issues` second pass; a standing
  backlog audit cron that labels failures `needs-design`.
- **#145 enforces where work lands** — a `verify.toml` integration gate *category* and
  a PR-ready gate that blocks a feature whose integration criterion isn't evidenced by
  a named integration/smoke/e2e test (with an explicit, human-authorized exemption
  escape hatch).
- **#146 keeps documents fresh** — a recommender-sibling cron that closes landed-but-open
  issues (with an evidence comment), flags spec lines describing a future phase whose
  work already merged (drift), and files proposal-first "reconcile" tasks.
- Each system is **integration-verified itself**: its own test exercises the real path
  (spawns the real `mm` CLI / drives the real gate / runs the real pass), not just a
  unit of the predicate.

## Phases (one per sub-issue)
1. **#144** — Requirements auditor: `@middle/core` rubric + `mm audit-issues` +
   `verifying-requirements` skill + `creating-github-issues` second pass + backlog-audit
   cron + `needs-design` labelling. Integration test spawns the real CLI against weak &
   well-formed fixtures.
2. **#145** — Integration-verified definition of done: `verify.toml` integration gate
   category (schema + parser + `verify.v1.md`); PR-ready gate requires evidenced
   integration test + `(integration-exempt: <url>)` escape hatch;
   `implementing-github-issues` definition-of-done update. Integration test drives the
   PR-ready gate against a fixture PR with/without an integration test.
3. **#146** — Anti-staleness reconciliation: gateway additions (close/create/list
   issues, closing-PR lookup); `reconcileStaleness` pass (close landed-but-open +
   evidence comment, `detectSpecDrift`, file proposal-first reconcile tasks); a
   rate-limit-guarded cron mirroring `reconcileMergedParks`. Integration test runs the
   pass against a fixture gateway + drifted spec.
4. **Epic end-to-end demonstration** — a single named test that ties the three together:
   weak issue flagged, unit-only feature blocked from PR-ready, landed-but-open issue +
   drifted spec line surfaced.

## Files likely to change
- `packages/core/src/integration-rubric.ts` (new) + `packages/core/src/index.ts` — shared rubric.
- `packages/cli/src/checks/issue-audit.ts` (new), `packages/cli/src/commands/audit-issues.ts` (new), `packages/cli/src/index.ts`, `doctor.ts` — `mm audit-issues`.
- `packages/skills/verifying-requirements/SKILL.md` (new); edits to `creating-github-issues` + `implementing-github-issues`; mirrors in `bootstrap-assets/skills/` and `.claude/skills/`.
- `packages/dispatcher/src/gates/verify-config.ts`, `schemas/verify.v1.md` — gate category.
- `packages/dispatcher/src/gates/pr-ready.ts` — integration evidence + exemption.
- `packages/dispatcher/src/github.ts` — gateway additions.
- `packages/dispatcher/src/staleness.ts` (new) + `staleness-cron.ts` (new) + `main.ts` — reconciliation pass + cron.
- `packages/dispatcher/src/audit-cron.ts` (new) + `main.ts` — backlog audit cron.
- Tests alongside each, under `packages/{core,cli,dispatcher}/test/`.

## Out of scope
- Auto-rewriting issues / auto-editing the spec prose (suggest + file tasks only; #144/#146 out-of-scope lines).
- Defining integration tests for genuinely infeasible systems — they declare an explicit exemption (#145 escape hatch), not silently.
- Durable persistence of the new crons across daemon restart (matches the existing in-memory engine; #116).

## Open questions
- None blocking. The rubric heuristic, the exemption token shape, and the drift-detection
  class are judgment calls resolved by the spec's own examples; documented in `decisions.md`.
