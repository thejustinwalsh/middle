# Issue #96: Docs harvester (Epic)

**Link:** https://github.com/thejustinwalsh/middle/issues/96
**Branch:** middle-issue-96
**Sub-issues:** #97 (docs target resolver), #98 (docs bot)

## Goal
Ship the automated docs surface as a sibling of the recommender: a **target resolver** that detects the repo's docs framework (Starlight / Docusaurus / MkDocs / TypeDoc) or falls back to markdown, plus a **scheduled/on-demand docs bot** that runs the `documenting-the-repo` skill against the resolved target — read-only/dry-run first, audit for drift, write only when enabled.

## Approach
- **Mirror the recommender, don't invent.** The recommender is the gold-standard sibling: a bunqueue `Workflow`, an orchestration runner (`recommender-run.ts`), a CLI command (`mm run-recommender`), a dashboard trigger seam, and a skill it invokes via a `buildPromptText` `kind`. The docs bot mirrors each piece.
- **The workflow orchestrates; the skill authors.** Generation voice/content + the audit logic live in the `documenting-the-repo` skill (already shipped, #95). The workflow's job is to resolve the target, assemble context, spawn the agent pointed at the skill, and gate writes. This is exactly the recommender↔`recommending-github-issues` relationship.
- **Resolver is adapter-shaped.** A `DocsTarget` interface parallel to `AgentAdapter`: detect from config signals, expose where output is routed. Single primary target by documented priority; `[docs]` config overrides detection.
- **Read-only first, like the recommender.** The recommender's write seam (`triggerAutoDispatch`) is deliberately UNWIRED; the docs bot's write mode is gated behind config the same way — the default run is an audit/dry-run that reports drift and writes nothing.
- **Cadence parity with the recommender.** The recommender is CLI- + dashboard-triggered; its cron "lands in Phase 2+" and is not live. The docs bot matches: full on-demand path (`mm docs <repo>`) + dashboard trigger seam + a config interval field. Acceptance is "cron *and/or* on demand" — on-demand is delivered fully.

## Phases
1. **`[docs]` config section** — `DocsSettings` type + `mapDocs` in `@middle/core/src/config.ts`; tests. Shared foundation; carries both the resolver override (`tool`, `path`) and the bot settings (`enabled`, `interval_minutes`, `adapter`, `write`). *(closes part of #97)*
2. **`@middle/docs` resolver package** — `DocsTarget` interface + detectors (starlight, docusaurus, mkdocs, typedoc) + markdown fallback + `resolveDocsTarget(repoPath, config)` honoring the config override and a documented priority order. Fixture repos + per-detector/fallback/override unit tests. *(closes #97)*
3. **`docs` prompt kind** — extend `BuildPromptOpts` union + `prompt.ts` in `@middle/adapter-claude` to invoke `/documenting-the-repo` with the assembled context; tests.
4. **`documentation` workflow + runner** — `createDocumentationWorkflow` (`packages/dispatcher/src/workflows/documentation.ts`) mirroring the recommender; `documentation-run.ts` orchestration with the write path gated (dry-run default) + dashboard trigger seam. Tests against stubs (no tmux/gh).
5. **`mm docs <repo>` CLI + cadence** — `commands/docs.ts` + registration in `index.ts`; `resolveDocumentationOptions`; config interval seam. Tests. *(closes #98)*
6. **Cross-cutting docs + verification** — front-door frontmatter on new `index.ts`, per-folder `CLAUDE.md` where the `claude-md` predicate holds, module-index discovery-test entry, `bun test` + `bun run typecheck` green, decisions → PR review comments.

## Files likely to change
- `packages/core/src/config.ts` — add `DocsSettings`, `mapDocs`, wire into `loadConfig`; `src/index.ts` re-export
- `packages/core/test/config.test.ts` — `[docs]` parsing + defaults
- `packages/docs/**` — **new package**: `package.json`, `src/index.ts` (front door), `src/target.ts`, `src/detectors/*.ts`, `src/resolve.ts`, `test/**` (+ fixtures)
- `packages/adapters/claude/src/prompt.ts` + `packages/core/src/adapter.ts` — `docs` prompt kind; prompt tests
- `packages/dispatcher/src/workflows/documentation.ts` — **new** workflow
- `packages/dispatcher/src/documentation-run.ts` — **new** orchestration runner
- `packages/dispatcher/src/main.ts` + `hook-server.ts` — dashboard trigger seam (mirror recommender)
- `packages/cli/src/commands/docs.ts` — **new** command; `packages/cli/src/index.ts` registration
- `packages/cli/test/module-index.test.ts` — add the new front door(s) to the discovery assertion
- root + nested `CLAUDE.md` as the `claude-md` predicate dictates

## Out of scope
- The generation **voice/content** and the **audit logic** — owned by the `documenting-the-repo` skill (#95, shipped). The workflow invokes it; it does not reimplement it.
- A **live cron**. Parity with the recommender, whose cron is explicitly deferred to "Phase 2+". The interval lives in config; the on-demand path is fully delivered (acceptance is "cron and/or on demand").
- Actually generating middle's own docs surface — that's a dogfood run of the shipped bot, not a code deliverable of this Epic.

## Open questions
- **Multiple co-resident frameworks** (e.g. `three-flatland` = Starlight + TypeDoc): resolve a single *primary* prose target by documented priority (Starlight > Docusaurus > MkDocs > TypeDoc > markdown), since TypeDoc typically nests *inside* a Starlight host via `starlight-typedoc`. Config override forces one. Will confirm the priority rationale in `decisions.md`. If a reviewer wants true multi-target fan-out, that's a follow-up.
