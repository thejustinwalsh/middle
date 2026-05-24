# Issue #91: Documentation conventions for humans and agents

**Link:** https://github.com/thejustinwalsh/middle/issues/91
**Branch:** middle-issue-91

## Goal
Establish the repo's documentation *conventions* — a machine-checked module-index
frontmatter, a TSDoc mandate, flag-driven per-folder `CLAUDE.md`, and a
`documenting-the-repo` authoring skill — so the sibling Docs-harvester Epic can
apply them automatically. This Epic ships the conventions and the enforcement,
not a docs site.

## Approach
- One leading TSDoc block per `index.ts(x)` does double duty: it is both the
  **module-index frontmatter** (#92, discovery) and the `@packageDocumentation`
  comment (#93, TypeDoc). They co-exist in one comment instead of competing.
- The frontmatter carries a `claude-md:` boolean. That flag is the **single
  source of truth** for whether the module gets a nested `CLAUDE.md` (#94) — no
  agent re-litigates it.
- Enforcement is a reusable check module that scans middle's own package tree
  (resolved from its module location, like the existing skills-drift check). It
  is **gating** via `bun test` (CI runs `bun test`) and **surfaced** as a warn in
  `mm doctor`, matching the skills-drift pattern.
- The `documenting-the-repo` skill ships through the existing skill model:
  authored canonically under `packages/skills/`, mirrored into
  `bootstrap-assets/` by `sync-skills`, enforced byte-identical by the pre-commit
  hook + `mm doctor`.

## Module-index frontmatter format (the standard for #92)
A single leading TSDoc block (after any shebang line):

```ts
/**
 * @packageDocumentation
 * @module @middle/core
 *
 * <1–2 line module purpose>
 *
 * Public surface:
 * - `loadConfig` — resolve + validate middle config
 *
 * Where things live:
 * - `config.ts` — config schema + loader
 *
 * Gotchas:
 * - <load-bearing invariant, or "None.">
 *
 * claude-md: false
 */
```

Machine-checked (gating) invariants:
1. First non-shebang, non-blank content is a `/** … */` block.
2. Contains `@packageDocumentation` (feeds TypeDoc — also satisfies #93).
3. Contains `@module <name>`.
4. Contains a `claude-md:` line whose value is exactly `true` or `false`.
5. Contains the three section headers (`Public surface:`, `Where things live:`,
   `Gotchas:`) so the format stays honest.
6. Flag↔presence consistency (#94): `true` ⇒ the module's `CLAUDE.md` exists;
   `false` ⇒ it must not. CLAUDE.md location = the index file's directory, or its
   parent when that directory is named `src` (so a package's `src/index.ts` maps
   to `<package>/CLAUDE.md`, and a nested `bootstrap/index.ts` to
   `bootstrap/CLAUDE.md`).

## Phases
1. **Module-index frontmatter (#92)** — define the format, apply to all 6 existing
   index files, add `src/index.ts` for `dispatcher` and `dashboard`, build the
   gating check (`bun test`) + `mm doctor` warn, document the format in root CLAUDE.md.
2. **TSDoc mandate (#93)** — root CLAUDE.md directive (TSDoc on public exports,
   `@packageDocumentation` on each index, describe behavior not names); advisory
   TSDoc-coverage check over each index's public surface (TS compiler API).
3. **Flag-driven per-folder CLAUDE.md (#94)** — document convention + objective
   predicate in root CLAUDE.md; flip `claude-md: true` for dispatcher,
   state-issue, cli/bootstrap; write those three nested CLAUDE.md files; the
   consistency check (built in Phase 1) now has teeth.
4. **documenting-the-repo skill (#95)** — author the skill (Diátaxis, LLM-ism
   blocklist + audit, voice anchored on Google/MS style guides, accuracy
   principle, encodes the three sibling conventions + the `docs/` surface); sync
   to bootstrap-assets; verify no drift.

## Files likely to change
- `packages/*/src/index.ts`, `packages/adapters/*/src/index.ts` — add frontmatter (8 files)
- `packages/dispatcher/src/index.ts`, `packages/dashboard/src/index.ts` — new front doors
- `packages/cli/src/checks/module-index.ts` (new) — the scan/check module
- `packages/cli/test/module-index.test.ts` (new) — gating test
- `packages/cli/src/commands/doctor.ts` — wire in warn-level checks
- `CLAUDE.md` (root) — frontmatter format, TSDoc directive, flag-driven CLAUDE.md convention
- `packages/dispatcher/CLAUDE.md`, `packages/state-issue/CLAUDE.md`, `packages/cli/src/bootstrap/CLAUDE.md` (new)
- `packages/skills/documenting-the-repo/SKILL.md` (new) + `bootstrap-assets/` mirror

## Out of scope
- The Docs-harvester Epic (the bot, target resolver, applying conventions repo-wide)
- Generating the actual API-docs/Starlight site
- Adding Astro Starlight / typedoc / llms-txt tooling (that's the harvester)

## Open questions
- TSDoc-coverage check: advisory vs gating. Plan: **advisory** (warn in doctor,
  informational), per #93's explicit "decide in implementation" — the gating
  doc-comment guarantee is `@packageDocumentation` presence (checked in Phase 1).
