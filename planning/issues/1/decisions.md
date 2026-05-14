# Decisions — Issue #1

## Scaffold at package granularity, not every leaf file
**File(s):** `packages/*/src/index.ts`
**Date:** 2026-05-14

**Decision:** Each package gets `package.json` + `tsconfig.json` + a single `src/` entry stub. The individual leaf files named in the spec's Repo layout (`watchdog.ts`, `classify.ts`, `routes/`, etc.) are NOT created as empty stubs.
**Why:** Issue #2's acceptance criterion lists *package directories* to scaffold, and its Out-of-scope says "implementing any package's source". Empty leaf stubs are structure without implementation — noise that later phases own. Package-level scaffold is the correct granularity for Phase 0.
**Evidence:** Issue #2 acceptance criteria + Out of scope; spec "Repo layout".

## Bun upgraded 1.3.5 → 1.3.14
**Date:** 2026-05-14

**Decision:** Ran `bun upgrade` to satisfy the spec's "Bun ≥1.3.12" stack requirement.
**Why:** The environment shipped Bun 1.3.5; issue #2 acceptance pins the stack at Bun ≥1.3.12.
**Evidence:** Spec "Tech stack"; issue #2 acceptance criteria.

## Schema doc is a verbatim extraction, not an expansion
**File(s):** `schemas/state-issue.v1.md`
**Date:** 2026-05-14

**Decision:** `schemas/state-issue.v1.md` is a faithful, verbatim extraction of the build spec's "State issue schema" fenced block — not an editorialized expansion. The parser-interface section keeps `ReadyRow`, `NeedsHumanItem`, etc. as bare names; their field shapes are derived (in code, Phase 3) from the per-section format descriptions.
**Why:** Issue #31 says the doc is "extracted from the build spec's 'State issue schema' section" and is "the source of truth, not a copy of the code". Expanding sub-types in the doc would make it a second spec that could drift from the build spec. The doc stays the contract; the code conforms to it.
**Evidence:** Issue #31 acceptance criteria; spec lines for "State issue schema".

## The `owners` metadata line is a fixed constant
**File(s):** `packages/state-issue/src/constants.ts` (`OWNERS_LINE`)
**Date:** 2026-05-14

**Decision:** The `<!-- owners: ... -->` metadata line is a hard-coded constant the renderer always emits and the parser requires verbatim. It is NOT captured in `ParsedState`.
**Why:** The schema doc's `ParsedState` type has no `owners` field, and #3 requires the types to match that interface exactly. The round-trip byte-identity property ("for any valid body") is logically impossible for a metadata line that varies but isn't captured — therefore the line must be invariant. Its value (`recommender=full-body, dispatcher=in-flight,rate-limits,slot-usage`) encodes the ownership split already described in the doc's "Diff semantics".
**Evidence:** Schema doc "Parser interface" (no `owners` field) + "Round-trip property"; issue #3 acceptance criteria.

## `[DISPATCHER-OWNED]` is doc annotation, not a body section header
**File(s):** `packages/state-issue/src/constants.ts` (`SECTION_NAMES`)
**Date:** 2026-05-14

**Decision:** Body section headers are exactly `## In-flight`, `## Rate limits`, `## Slot usage` — the `[DISPATCHER-OWNED]` suffix in the schema doc's `### N. ## Name  [DISPATCHER-OWNED]` headings is not emitted or required in the body.
**Why:** The `### N.` prefix is clearly the doc's own enumeration; `## Name` is "what the header looks like". `[DISPATCHER-OWNED]` reads as a parenthetical note in the same vein, and the doc's "Diff semantics" section already states the ownership split in prose — encoding it in headers too would be redundant. Validation rule 2 ("all 7 sections in order") is also simplest with clean `## <Name>` headers.
**Evidence:** Schema doc "Sections (in order)" + "Diff semantics".

## Empty sections 2/3/5 render as header-only
**File(s):** `packages/state-issue/src/renderer.ts` (`renderSection`)
**Date:** 2026-05-14

**Decision:** When "Needs human input", "Blocked", or "Excluded" are empty, the canonical body emits just the `## <Name>` header with no content line. Sections 1 ("Ready to dispatch") and 4 ("In-flight") keep their documented empty-state lines.
**Why:** The schema doc documents explicit empty states only for sections 1 and 4 — a markdown table needs a row to be non-degenerate, and "no agents in flight" is a meaningful status worth surfacing. The omission for 2/3/5 is intentional: an empty bulleted list is unremarkable. Inventing empty-state lines for 2/3/5 would make the code diverge from the doc, which #31 designates the source of truth.
**Evidence:** Schema doc sections 1–7 (only 1 & 4 specify "Empty"/"Empty state"); issue #31 ("parser conforms to this doc").

## Schema-underspecified fields stored as raw strings
**File(s):** `packages/state-issue/src/schema.v1.ts`
**Date:** 2026-05-14

**Decision:** Fields the schema doc doesn't structurally decompose are kept as raw strings: `ReadyRow.epic` ("#<n> <title>"), `BlockedItem.blocker` ("#<n>" or "`desc`"), `NeedsHumanItem.link`, `InFlightItem.progress`, and all `RateLimits` values.
**Why:** Phase 0's job is a parser that conforms to the schema and round-trips byte-identically — not an ergonomic API for the dispatcher/dashboard (those are later phases). Raw strings round-trip trivially and avoid guessing at decompositions the doc doesn't specify. `validate()` still regex-checks the `#N` shape of `epic`/`blocker` for rule 4. Downstream consumers can decompose further when their needs are concrete.
**Evidence:** Schema doc per-section formats; issue #3 scope ("parser conforms to schema").

## typecheck via `tsc --noEmit`, not `tsc --build`
**File(s):** `package.json`
**Date:** 2026-05-14

**Decision:** Root `typecheck` script is `tsc --noEmit`.
**Why:** `tsc --build` requires TS project references (`composite: true` per package + `references` in root). That's machinery Phase 0 doesn't need — a flat `--noEmit` check over the workspace is sufficient and simpler. Project references can be added later if build performance demands it.
**Evidence:** No spec requirement for `tsc --build`; `bun` runs TS natively so `tsc` is type-checking only.
