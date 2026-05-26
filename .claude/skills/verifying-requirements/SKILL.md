---
name: verifying-requirements
description: Use when filing or auditing GitHub issues to check their acceptance criteria demand integration into the running product, not just green unit tests. Defines the integration rubric and drives `mm audit-issues`. Triggers include "audit these issues", "do the acceptance criteria hold up", "harden this issue's requirements", and the second pass inside creating-github-issues. Suggests rewrites; does NOT implement, does NOT silently edit issues.
allowed-tools: Bash(mm:*), Bash(gh:*), Read, Grep, Glob
---

# Verifying Requirements

The requirements auditor (Epic #143, the keystone of middle's self-auditing). It fixes
the *requirements contract* so work integrates into the running product instead of
stopping at green unit tests — middle's recurring failure mode (a dashboard package the
daemon never serves; a docs harvester that audits but never produces a corpus). A feature
that satisfies the *letter* of its criteria ("a function returns X, tests pass") without
the *intent* (a reachable, used feature) passed criteria that were too weak. This skill
makes the criteria demand the intent.

## Core principle — the integration rubric

**Every feature issue must carry ≥1 acceptance criterion that is an *integration
criterion*.** An integration criterion does both of:

1. **Wires the feature into the running product** — it is mounted, served, invoked,
   reachable, or dispatched. *Exported* is not enough: a function nothing calls is not a
   feature.
2. **Is proven by an integration / smoke / e2e test that exercises that real path** — the
   test boots the daemon, drives the CLI, GETs the endpoint, or otherwise runs the live
   path. A unit test of the function in isolation is not enough.

"Unit tests pass" alone **fails** the rubric. Both halves must be present in the same
criterion (or set of criteria): the wiring *and* the real-path test.

### The canonical example

> `mm start` serves the dashboard at `/`; a smoke test boots the daemon and GETs `/`,
> asserting the SPA shell renders and a live `/control/events` frame arrives.

Wiring (`mm start` serves the dashboard at `/`) **and** real-path proof (a smoke test
boots the daemon and GETs `/`). Contrast the weak form it replaces: "the dashboard SPA
builds and unit tests pass" — exported, never served, never proven reachable.

## When to use

- **Second pass inside `creating-github-issues`** — audit each drafted issue body *before*
  filing (see that skill's Phase 8.5).
- **Standing backlog audit** — sweep open issues and flag the ones whose criteria are too
  weak. The dispatcher runs this on a cron; you can run it by hand to triage.
- The user asks to harden an issue, or asks whether its acceptance criteria are strong
  enough to keep the implementer honest.

**Don't use for:** non-feature issues (docs, chore, housekeeping, an Epic umbrella whose
*sub-issues* carry the criteria). The audit tool already excludes these by label.

## How to run the audit

`mm audit-issues` is the mechanical core — it evaluates a body against the rubric and
reports pass/fail with a concrete suggested rewrite. Three modes:

```bash
# A drafted body, before it is filed (the creating-github-issues second pass).
mm audit-issues <repo> --body-file draft.md --title "Activity dashboard view"

# One existing GitHub issue.
mm audit-issues <repo> --issue 152

# The whole open backlog; label failures `needs-design` (the standing audit).
mm audit-issues <repo> --label
```

Exit code is **0 when every audited issue passes, 1 when any fails** — so it doubles as a
gate. Add `--json` for machine-readable output.

### Reading the result

A failing issue prints the missing-criterion diagnosis **and a concrete suggested rewrite**
anchored to the issue's title. Don't paste the suggestion verbatim — adapt it to the
feature: name the real command/route/surface and the real observable the test will assert.

A passing issue names the integration criterion (or the declared exemption) that satisfied
the rubric.

## Labelling — `needs-design`, never a silent edit

A failing issue is labelled **`needs-design`** until its criteria are hardened (the
standing audit does this with `--label`). The skill **suggests** rewrites; it never
silently rewrites an issue body. Hardening is a human or a follow-up action on the
flagged issue — the audit's job is to flag and propose, exactly like a code reviewer.

## The escape hatch — declare an exemption, don't dodge

A few features genuinely have no integration path to exercise (a pure type-level package;
a constant table). Those declare the exemption **explicitly in the issue body**, so the
absence is intentional and reviewable rather than an oversight:

```markdown
<!-- integration-exempt: pure type-level package; no runtime path to exercise -->
```

`mm audit-issues` treats a declared exemption as a pass and surfaces the reason. At
PR-ready time the gate requires the exemption to be **human-authored** (a non-bot comment),
so an agent can't write its own escape hatch. If you can't articulate why integration is
infeasible, it isn't — write the criterion instead.

## Red flags — STOP and self-correct

| Thought | Reality |
|---|---|
| "Unit tests pass — that's a fine criterion" | It's the exact failure mode this rubric exists to kill. Add the wiring + real-path test criterion. |
| "The function is exported, so the feature ships" | Exported ≠ reachable. The rubric demands mounted/served/invoked, proven by a test. |
| "I'll just paste the suggested rewrite" | The suggestion is a template. Name the real surface and the real observable. |
| "This issue can't have an integration test" | Then declare an explicit `integration-exempt:` reason. If you can't, it isn't exempt. |
| "I'll edit the weak issue to pass" | Suggest and flag (`needs-design`). The skill proposes; it never silently rewrites. |
| "Audit only the issue I was asked about" | Offer the standing backlog sweep too — weak criteria cluster. |

## Related skills

- `creating-github-issues` — runs this as a second pass before filing (Phase 8.5).
- `implementing-github-issues` — the downstream enforcer: its definition of done and the
  PR-ready gate require the integration criterion to be *evidenced* by a named test, so the
  contract this skill writes is the contract that skill checks at landing time.
