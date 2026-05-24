# Decisions — Issue #91 (Documentation conventions)

## One leading TSDoc block serves both #92 (frontmatter) and #93 (@packageDocumentation)
**File(s):** every `packages/*/src/index.ts`
**Date:** 2026-05-24

**Decision:** Rather than two competing comments atop each index, a single leading
TSDoc block carries the module-index frontmatter (purpose / public surface /
where-things-live / gotchas / `claude-md` flag) *and* the `@packageDocumentation`
+ `@module` tags TypeDoc consumes.
**Why:** #92 and #93 explicitly frame themselves as "co-existing." One block is
the natural resolution — no ambiguity about which comment is authoritative, and
the discovery frontmatter is exactly the prose TypeDoc surfaces as the module's
overview. Two blocks would drift.
**Evidence:** #92 body ("co-exists with TSDoc/@packageDocumentation"), #93 body
("co-exists with the bespoke module-index frontmatter").

## The `claude-md:` flag is the single source of truth; the check enforces flag↔presence
**File(s):** `packages/cli/src/checks/module-index.ts`
**Date:** 2026-05-24

**Decision:** The frontmatter's `claude-md: true|false` deterministically decides
whether a nested `CLAUDE.md` exists. The check verifies physical consistency:
`true` ⇒ file present, `false` ⇒ file absent. CLAUDE.md location = index's dir, or
the parent when the dir is `src`.
**Why:** Epic acceptance demands presence be "driven deterministically by that
flag (no agent re-litigates it)." A documented convention alone still lets agents
drift; a consistency check makes the flag truly load-bearing and catches a flag
flipped without its file (or vice-versa).
**Evidence:** Epic #91 + #94 acceptance criteria.

## Enforcement is gating via `bun test`, advisory via `mm doctor`
**File(s):** `packages/cli/test/module-index.test.ts`, `packages/cli/src/commands/doctor.ts`
**Date:** 2026-05-24

**Decision:** The module-index frontmatter check is a failing `bun test` (CI gate)
and a warn-level line in `mm doctor`. The TSDoc-coverage check (#93) is advisory
only (warn + informational test).
**Why:** Mirrors the existing skills-drift pattern — gating enforcement lives in
the test/pre-commit layer; `mm doctor` surfaces repo-integrity warnings to an
operator without blocking `mm dispatch`. #93 explicitly leaves advisory-vs-gating
to implementation; the hard doc-comment guarantee is `@packageDocumentation`
presence (already gated by the frontmatter check), so coverage can stay advisory.
**Evidence:** `doctor.ts:84-95` (skills check is warn); `scripts/hooks/pre-commit`
(hard gate); #93 body ("decide advisory vs gating in implementation").
