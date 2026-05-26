# Decisions — Epic #143

## Shared integration rubric lives in `@middle/core`
**File(s):** `packages/core/src/integration-rubric.ts`
**Date:** 2026-05-26

**Decision:** Put the "integration criterion" predicate and the issue-audit result type
in `@middle/core`, not in the CLI check or the dispatcher gate.

**Why:** Both the requirements auditor (#144, in `@middle/cli`) and the PR-ready gate
(#145, in `@middle/dispatcher`) must agree on what counts as an integration criterion. A
single predicate is the only way the contract enforced at filing time matches the one
enforced at landing time. `@middle/core` is the foundation both packages already import
(per their `package.json` deps), so it's the natural home and introduces no new dependency
edge.

**Evidence:** `packages/cli/package.json` and `packages/dispatcher/package.json` both
depend on `@middle/core` (`workspace:*`); the existing shared hook scripts (`PR_READY_GATE_SH`)
already live there.

## "Integration criterion" predicate: wiring-signal AND real-path-test-signal
**File(s):** `packages/core/src/integration-rubric.ts`
**Date:** 2026-05-26

**Decision:** A criterion is an *integration criterion* iff its text contains **both** a
product-wiring signal (served/mounted/invoked/reachable/wired/booted/GET/POST/`mm `/endpoint/route…)
**and** a real-path-test signal (integration test / smoke test / e2e / end-to-end /
exercises / boots the / drives the / real path…). The bare phrase "unit test(s) pass" is
explicitly insufficient. An issue passes the rubric if ≥1 of its acceptance criteria is an
integration criterion, OR it carries an explicit exemption.

**Why:** This is the smallest predicate that captures the spec's intent ("mounted, served,
invoked, reachable — not merely exported" AND "proven by an integration/smoke/e2e test that
exercises that real path") while staying a deterministic, testable string check rather than
an LLM judgment. The spec's own worked example ("`mm start` serves the dashboard at `/`; a
smoke test boots the daemon and GETs `/`") matches both signal classes, which anchors the
heuristic.

**Evidence:** Spec → "Self-auditing…" → "1. Requirements auditor"; sub-issue #144 acceptance
criterion 1.

## Exemption + deferral reuse the `(token: <comment-url>)` + non-bot-author shape
**File(s):** `packages/dispatcher/src/gates/pr-ready.ts`
**Date:** 2026-05-26

**Decision:** The integration escape hatch is `(integration-exempt: <comment-url>)`,
validated exactly like the existing `(deferred: <comment-url>)` annotation — the linked
comment's author must be a non-bot user.

**Why:** Consistency with the established, already-tested deferral mechanism; reuses
`resolveCommentAuthor`; keeps "declare the exemption explicitly … not silently" honest by
requiring a human-authored trail rather than a self-asserted body line an agent could write.

**Evidence:** Existing `DEFERRED_RE` + `resolveCommentAuthor` in `pr-ready.ts`; sub-issue
#145 out-of-scope line ("declare the exemption explicitly in the issue … not silently").

## Each system is dogfood-verified by exercising its own real path
**File(s):** test files per phase
**Date:** 2026-05-26

**Decision:** #144's test spawns the real `mm audit-issues` CLI; #145's drives the real
`evaluatePrReady` decision path; #146's runs the real `reconcileStaleness` pass against the
real `GitHubGateway` interface (in-memory impl). No phase ships only a unit test of its
predicate.

**Why:** This is the very contract the Epic introduces — a feature is proven by a test that
runs the real path, not a unit stub. The auditing systems must hold themselves to it.

**Evidence:** Each sub-issue's "Integration-verified itself" acceptance criterion.
