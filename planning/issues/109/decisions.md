# Issue #109 — decisions log

Source for the PR review comments (Phase 8). Append as decisions are made.

## Bottom-up phase ordering; standalone path deleted last
**File(s):** whole epic
**Date:** 2026-05-24

**Decision:** Land the 6 sub-issues bottom-up — factory (#110) → EventHub (#111)
→ routes (#112) → daemon wiring (#113) → client (#114) → delete standalone path
(#115).
**Why:** Each phase is then a small, independently-verifiable diff, and the
risky deletion (#115) lands only after its replacement (the daemon engine + the
thin client) is proven green. Deleting first would leave the tree broken across
several phases.
**Evidence:** The Epic plan comment prescribes this order; matches the repo's
"rebase, atomic commits" convention.
