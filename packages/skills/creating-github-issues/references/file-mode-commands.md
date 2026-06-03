# creating-github-issues — file-mode commands

Authoring Epic **files** from a planning doc, for a repo running `epic_store = "file"`.
There is **no `gh issue create` in file mode** — Epics and their sub-issues are
Markdown, not GitHub issues. PRs/reviews/CI remain GitHub-native, but issue
creation is not part of file mode at all.

The workflow phases (read the source, inventory, decide hierarchy, triage unknowns,
audit against the integration rubric) are identical to the GitHub-mode body. Only
the "file the issues" mechanics change: instead of `gh issue create` + sub-issue
REST attaches, you write one Epic file per Epic.

## Where files go

`epics_dir` from the repo's `.middle/<repo>.toml` (default `planning/epics/`). One
file per Epic: `planning/epics/<slug>.md`. The `<slug>` is the filename stem **and**
the canonical Epic reference — it must equal the `slug:` in the file's meta.

## Author one Epic file

Write `planning/epics/<slug>.md` with this structure (mirror the marker names
exactly — the markers ARE the structural contract):

```markdown
<!-- middle:epic v1 -->
# <Epic title>

<!-- middle:meta
slug: <slug>
adapter: claude
complexity_ceiling: 3
approved: false
labels: [phase:10, dogfood]
blocked-by: [other-epic-slug]
-->

## Context

<1-3 paragraphs pointing to the spec section; same content as a GitHub-mode
parent's Context.>

## Acceptance criteria

- [ ] <Epic-level, concrete, verifiable criterion>
- [ ] <…>

## Sub-issues

<!-- middle:sub-issue id=1 -->
- [ ] **1 — <verb-led title>**
  <prose body>
  *Acceptance:* <concrete criteria for this phase>
<!-- /middle:sub-issue -->

<!-- middle:sub-issue id=2 -->
- [ ] **2 — <verb-led title>**
  <prose body>
  *Blocked by:* 1
<!-- /middle:sub-issue -->

<!-- middle:conversation -->
<!-- /middle:conversation -->
```

## The `<!-- middle:meta -->` keys

YAML-lite, one key per line, between `<!-- middle:meta` and `-->`:

| Key | Required | Meaning |
|---|---|---|
| `slug` | yes | Canonical Epic reference; must equal the filename stem. |
| `adapter` | no | `claude` / `codex` — the file-mode peer of an `agent:<name>` label. |
| `labels` | no | Display labels (informational; no GitHub side-effect in file mode). |
| `blocked-by` | no | List of other Epic slugs this one waits on (cross-Epic deps). |
| `complexity_ceiling` | no | Per-Epic override of the repo's default ceiling. |
| `approved` | no | File-mode stand-in for the `approved` label. |

(`pr:` and `closed:` also live in meta but are written by the dispatcher at
runtime — do not author them.)

## Rules that carry over from the GitHub-mode body

- **Acceptance criteria are mandatory** — both Epic-level (`## Acceptance criteria`)
  and per sub-issue (`*Acceptance:*`). Same concrete/verifiable/scoped bar.
- **Integration rubric (Phase 8.5)** — every feature Epic carries ≥1 criterion that
  wires the feature into the running product and proves it with an
  integration/smoke/e2e test, or a declared `<!-- integration-exempt: <reason> -->`.
- **Hierarchy by default** — the Epic file *is* the parent; its sub-issue blocks are
  the children. A genuinely cross-workstream item is a separate Epic file.
- **Titles are the most-read line** — verb-led, scoped, ≤72 chars, both for the H1
  and each sub-issue title.

## Leave the conversation empty

Author the file with an empty `<!-- middle:conversation --><!-- /middle:conversation -->`.
The dispatcher's renderer is the **sole writer** of conversation entries (plan,
dispatch events, questions, answers). Never seed conversation content by hand — that
would break the strict-marker contract and the byte-identical round-trip invariant.

## Verify the set

There's no `gh issue list` to confirm against in file mode. Verify by:

```bash
ls planning/epics/*.md
```

and re-reading each file: the H1 matches `slug`, every sub-issue has an id + an
unchecked box, acceptance criteria are present, and the conversation section is
empty. Optionally run the dispatcher's parser over each file (it refuses malformed
markers) before considering the set filed.
