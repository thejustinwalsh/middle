---
name: documenting-the-repo
description: Use when writing or revising any documentation in this repo — README, docs/ guides, TSDoc on public exports, module-index frontmatter, per-folder CLAUDE.md, or prose the Docs-harvester bot generates. Enforces Diátaxis (every doc is exactly one of tutorial / how-to / reference / explanation), the repo's voice (Google + Microsoft style guides), an LLM-ism blocklist, and the accuracy rule that code samples come from working source. Triggers include "write docs for X", "document this package", "audit the docs", "fix the README", "add a how-to". Authoring + audit only — does NOT change code behavior, does NOT open PRs.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash(bun:*), Bash(git:log:*), Bash(git:status)
---

# Documenting the repo

The one skill that governs the whole documentation surface — so a human reader and a dispatched agent find the same context, in the same shape, written in the same voice. The Docs-harvester Epic calls this skill to author; any agent touching docs follows it too.

## What this governs

| Surface | Where | Authoritative rule |
|---|---|---|
| Module front door | `src/index.ts(x)` frontmatter | root `CLAUDE.md` → "Module-index frontmatter" |
| API reference | TSDoc on public exports | root `CLAUDE.md` → "TSDoc on public surfaces" |
| Local conventions | per-folder `CLAUDE.md` | root `CLAUDE.md` → "Per-folder `CLAUDE.md`" |
| Guides & narrative | `docs/`, `README.md` | this skill (Diátaxis + voice + accuracy) |

This skill does not restate those CLAUDE.md rules — it points at them and adds what they don't cover: **mode, voice, and accuracy**. The checks (`packages/cli/src/checks/`) gate structure; this skill governs prose.

## Core principles

**One doc, one mode.** Every document is exactly one Diátaxis type. A doc that teaches *and* specifies *and* explains serves none of them. If you can't name the single mode, the doc isn't ready.

**The reader's job, not the writer's reflexes.** Each sentence earns its place by changing what the reader knows or can do. Empty scaffolding — "In this guide we will explore…", "It's worth noting that…", a closing "In conclusion…" — is cut, not softened.

**Samples are extracted, never invented.** A code sample is copied from working source (a test, an example, a real call site) and cross-referenced against it. An invented sample that drifts from the API is worse than no sample.

## Diátaxis — pick one mode

| Mode | Answers | Reader is | Shape |
|---|---|---|---|
| **Tutorial** | "teach me, start to finish" | learning | numbered lessons, one happy path, no choices |
| **How-to** | "help me do X" | working toward a goal | steps for one task, assumes competence |
| **Reference** | "what exactly is X" | looking something up | dry, complete, structured; no narrative |
| **Explanation** | "why is it this way" | wanting to understand | discussion, tradeoffs, alternatives, context |

The test: name the mode in one word before writing. **Reject mixed-mode docs** — split a "tutorial that also explains the architecture" into a tutorial plus an explanation that links to it. Reference material (API contracts, config keys, schema fields) never carries narrative; explanation never carries step-by-step procedure.

## Voice & style

Anchored on the **Google developer-documentation style guide**, the **Microsoft Writing Style Guide**, and **Diátaxis** voice. The load-bearing rules:

- **Second person, present tense, active voice, imperative for steps.** "Run `bun test`." Not "The tests can be run by the user."
- **Address the reader as "you"; the project as its name** (`middle`, `mm`), never "we" in reference/how-to. "We" is acceptable only in explanation, sparingly.
- **Short sentences. One idea each.** Prefer a period to a comma-and.
- **Define an acronym on first use; then use it.** Don't toggle between the term and its expansion.
- **Lead with the point.** First sentence of a section states the conclusion; details follow.
- **Code, paths, commands, and identifiers in backticks.** Reference files as `path:line` where it helps.
- **Sentence case for headings.** Match the surrounding files.

## LLM-ism blocklist

Strip these on every pass. They are the tells of generated prose; their presence is a defect.

- **Inflated diction:** delve, leverage (as a verb), robust, seamless, utilize, facilitate, underpin, multifaceted, realm, landscape, tapestry, testament, pivotal, crucial, vital, ever-evolving.
- **Hedge-and-filler phrases:** "it's worth noting that", "it's important to note", "as we can see", "in today's fast-paced world", "at the end of the day", "needless to say".
- **Empty intros & conclusions:** an opening paragraph that restates the title; a closing paragraph that summarizes what was just said ("In conclusion…", "Overall…"). Delete both — start at the first real sentence, end at the last real instruction.
- **Rule-of-three filler:** reflexive triples where two items, or one, carry the meaning ("fast, efficient, and performant"). Keep the one that's true.
- **False balance:** "Whether you're a beginner or an expert…", "From small scripts to large systems…". Cut it; address the actual reader.
- **Promotional tone:** "powerful", "cutting-edge", "effortlessly", "simply", "just" (when the thing isn't simple).

### The audit pass

When auditing existing docs (or your own draft before shipping):
1. Classify the doc's Diátaxis mode. If it's mixed, split it.
2. Grep the blocklist over the file; rewrite or delete each hit. Don't swap one inflated word for another — cut to the plain verb.
3. Delete the intro if it restates the title; delete the conclusion if it summarizes.
4. Verify every code sample against source (below).
5. Read it once as the target reader: does each sentence change what they know or do?

## Accuracy — samples from working source

This is the `docs-audit` principle: documentation that drifts from the code is a liability.

- **Extract, don't author.** Pull a sample from a passing test, a real call site, or an example file. Cite where it came from (`packages/x/test/y.test.ts`).
- **Cross-reference signatures.** A documented function signature must match the TSDoc / source exactly — argument names, types, order. Grep the source; don't recall it.
- **Run what you show, where you can.** A how-to's commands should be the commands that actually work (`bun test`, `bun run typecheck`, `mm doctor`). Verify before publishing.
- **Date or version volatile facts.** Counts, limits, and "current" statements drift; tie them to a source the reader can re-check.

## Workflow

1. **Identify the surface and mode.** Which surface (table above)? Which single Diátaxis mode? Write both down before drafting.
2. **Ground in source.** Read the code, the relevant `CLAUDE.md`, and any existing doc. Extract samples from working examples.
3. **Draft in the voice.** Lead with the point; second person; one idea per sentence.
4. **Audit.** Run the audit pass — mode, blocklist, intros/conclusions, sample accuracy, reader read-through.
5. **Verify structure.** For code-surface docs, `bun test` (the `module-index` and `tsdoc` checks) must stay green; `mm doctor`'s `docs`/`tsdoc` lines reflect the surface.

## Red flags — STOP and self-correct

| Thought | Reality |
|---|---|
| "I'll add a quick intro paragraph for context" | If it restates the title, it's filler. Start at the first real sentence. |
| "This guide can teach and explain at once" | One doc, one mode. Split it. |
| "I'll write a plausible code sample" | Plausible drifts. Extract from a test or call site and cite it. |
| "`robust` / `seamless` / `leverage` fits here" | It's on the blocklist. Use the plain verb. |
| "A closing summary ties it together" | The reader already read it. Delete the conclusion. |
| "I'll restate the round-trip invariant in the package doc" | Root `CLAUDE.md` owns it. Link, don't duplicate. |
| "Three adjectives sound thorough" | Keep the one that's true. |

## Files this skill creates or edits

- `docs/**`, `README.md` — guides and narrative (one Diátaxis mode each)
- TSDoc comments on public exports; `index.ts(x)` frontmatter; per-folder `CLAUDE.md` — per the root `CLAUDE.md` conventions this skill points at

It does not change code behavior and does not open PRs.
