# implementing-github-issues — file-mode commands

The file-mode equivalents of every Epic/plan/sub-issue/conversation operation the skill body refers to mode-agnostically. In **file mode** the Epic is a Markdown file at `planning/epics/<slug>.md` (the slug is the file's stem and the canonical Epic reference), and the agent-↔-human conversation lives in that file's `<!-- middle:conversation -->` section. **PRs, reviews, and CI stay GitHub-native** — the PR/CI commands are identical to GitHub mode (`gh pr …`).

## The one rule that governs every write below

**The renderer is the sole writer of strict markers.** Every `<!-- middle:* -->` marker (and its strict attribute line — `id=`, `status=`, `ts=`, `kind=`, the `<!-- middle:meta -->` keys) is written and rewritten only by the dispatcher's renderer (`renderEpicFile`). You never hand-edit a strict marker or its attributes. You write **only** between markers — sub-issue checkboxes, prose bodies, conversation entry bodies. This is what keeps #180's writer/parser-drift class closed for file mode, and it's what makes the file's byte-identical round-trip invariant hold under concurrent dispatcher + human edits.

Practically: the dispatcher appends conversation entries (plan, dispatch-event, question) **for** you via the renderer when you write `.middle/blocked.json` or hit a gated step; you flip sub-issue checkboxes and append provenance prose yourself.

## The Epic file format (mirror these marker names exactly)

```markdown
<!-- middle:epic v1 -->
# <Title>

<!-- middle:meta
slug: <slug>
adapter: <claude|codex>          # optional
complexity_ceiling: <N>          # optional
approved: <true|false>           # optional
labels: [<label>, <label>]       # optional, informational
blocked-by: [<other-slug>]       # optional, cross-Epic deps
pr: <number>                     # stamped by dispatcher when the PR opens
-->

## Context
<prose>

## Acceptance criteria
- [ ] <criterion>

## Sub-issues

<!-- middle:sub-issue id=1 -->
- [ ] **1 — <title>**
  <prose body>
  *Acceptance:* <…>
<!-- /middle:sub-issue -->

<!-- middle:conversation -->
<!-- /middle:conversation -->
```

## Fetch the Epic's context (Phase 1)

Read the Epic file:

```bash
cat planning/epics/<slug>.md
```

Read the body, the `## Acceptance criteria`, every `<!-- middle:sub-issue -->` block, and every entry inside `<!-- middle:conversation -->` — questions, dispatch events, and any answers are all there. The latest decisions are often in the conversation section.

## Fetch the Epic's sub-issues (the phases of your plan)

Each `<!-- middle:sub-issue id=N -->` block is one phase. An *open* sub-issue is one whose checkbox is unchecked (`- [ ]`); a *closed* one is checked (`- [x]`). Work the open ones in dependency order (`*Blocked by:* N` lines express the order).

## Post the plan to the Epic (Phase 4)

The plan goes into the Epic file's `<!-- middle:conversation -->` section as a conversation entry — **written by the renderer, not by hand.** Under middle's dispatch this is the plan step the dispatcher records via the renderer; the plan-comment guard then verifies a plan entry exists in the conversation section. You author the plan body (in `planning/epics/<slug>.md`'s adjacent `planning/issues/<slug>/plan.md`, same as GitHub mode); the renderer appends it to the conversation. Do not edit the conversation markers yourself.

## Close a sub-issue with evidence

Closing a sub-issue = flipping its checkbox from `- [ ]` to `- [x]` and appending a one-line provenance suffix to the title line. The checkbox and the title prose are *between* markers, so you edit them directly:

```markdown
<!-- middle:sub-issue id=1 -->
- [x] **1 — Implement the CodexAdapter** *(done in wf_…oyy4c4m1, sha abc1234)*
  Full AgentAdapter: …
<!-- /middle:sub-issue -->
```

The recommender's "open sub-issues" count scans for unchecked boxes, so a checked box with a provenance suffix is the file-mode equivalent of `gh issue close --reason completed --comment "Done in <sha> …"`. Do **not** touch the `<!-- middle:sub-issue id=N -->` marker or its `id=` attribute — only the checkbox glyph and the prose.

## Ask a question / surface a blocker

Identical agent action to GitHub mode: write `<worktree>/.middle/blocked.json` and exit. The dispatcher's file-backed writer appends a `<!-- middle:question id=N status=open … -->` block to the conversation section **via the renderer** — you never write the question marker yourself. The human answers by editing the `<!-- middle:answer for=N -->` block in the file (the file-watcher fires resume when that block becomes non-empty) or by running:

```bash
mm resume <repo> <slug> --answer "…"
```

`mm resume` is the manual unblock — the Phase 1 escape hatch before the watcher, and a permanent fallback.

## File a follow-up as a sub-issue under a parent (Phase 9)

A sub-issue is a new `<!-- middle:sub-issue id=N -->` block in the Epic file. Append it **via the renderer** (the renderer assigns the next `id` and emits the strict marker) — under middle's dispatch this is the same write path the dispatcher uses; do not hand-author the marker. Author the block body:

```markdown
- [ ] **N — <descriptive title>**
  Context: <what you saw, where>.
  Why a sub-issue and not in-scope: <…>.
  *Suggested approach:* <if you have one>
```

A "parent for a natural collection" is the Epic itself — file each related item as an additional sub-issue block under `## Sub-issues`. **There is no `gh issue create` in file mode** for Epic data; everything lives in the Epic file.

## File a standalone follow-up (the exception)

A genuinely cross-workstream item is a *new Epic file*: author `planning/epics/<other-slug>.md` with its own `<!-- middle:epic v1 -->` + `<!-- middle:meta -->` (see "creating-github-issues" file-mode addendum). A "Discovered while working on: <slug>" line in its Context is the cross-reference. Again — no `gh issue create`.

## PR / CI operations (GitHub-native — same as GitHub mode)

PRs, reviews, and CI are GitHub-native in file mode too. Use the same commands the skill body lists inline:

| Operation | Command |
|---|---|
| Open draft PR up front | `gh pr create --draft --title "..." --body "..."` (include `<!-- middle:epic <slug> -->` in the PR body so `findEpicPr` can match it) |
| Update PR body | `gh pr edit <pr> --body-file ...` (or PATCH via `gh api`) |
| Check mergeability | `gh pr view <pr> --json mergeable,mergeStateStatus` |
| Mark PR ready | `gh pr ready <pr>` |
| Post a file/line review comment | `gh api .../pulls/<pr>/comments -F line=N -f path=... -f body=...` |
| Get PR review comments | `gh api repos/{o}/{r}/pulls/<pr>/comments` |

The dispatcher stamps `pr: <number>` into the Epic file's `<!-- middle:meta -->` when the PR opens (a durable backup for the PR-body marker) — that write is the renderer's, not yours.
