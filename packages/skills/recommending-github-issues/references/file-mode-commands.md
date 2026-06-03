# recommending-github-issues — file-mode commands

The file-mode equivalents of the recommender's state read/write. In **file mode**
the dispatch units are Epic files under `epics_dir` (default `planning/epics/`),
and the state body is the `state_file` on disk (default `.middle/state.md`). PRs,
reviews, and CI are GitHub-native (`gh pr …`) — only the Epic *data* and the state
body are file-backed.

## The one rule that governs the write

**The renderer is the sole writer of the state body.** You write `state_file` via
`renderStateIssue` (the same parser + renderer + byte-identical-round-trip
invariant as GitHub mode's state-issue flow) — **never by hand**. There is no
recommender-agent rewriting strict sections out-of-band; this closes #180's class
entirely for file mode. You compose the state model and render it; you do not
hand-edit the file's markers or the dispatcher-owned sections (In-flight, Rate
limits, Slot usage).

## Scan the dispatch units (Phase 2)

The recommender **scans `epics_dir`** for Epic files and parses each:

```bash
ls epics_dir/*.md          # epics_dir from the repo config (default planning/epics/)
```

For each `planning/epics/<slug>.md`:
- Read `<!-- middle:meta -->` for `slug`, `adapter`, `labels`, `approved`,
  `closed`, and `blocked-by` (the cross-Epic dependency slugs the graph builder
  reads).
- Skip files marked `closed: true` in meta — they're out of the open set.
- Each `<!-- middle:sub-issue id=N -->` block is a phase; an **open** sub-issue is
  an unchecked box (`- [ ]`), a **closed** one is checked (`- [x]`). The open-
  sub-issue count is the Epic's phase count — a fact from the file, never an
  estimate.
- An Epic with no open sub-issues is `excluded` (`no open sub-issues`).

The `state_file` is not an Epic file and never appears in `epics_dir` — it is never
a dispatch unit.

## Cross-reference open PRs (Phase 2, GitHub-native)

PRs/reviews/CI stay on GitHub in file mode. Match each open PR to its Epic by the
`<!-- middle:epic <slug> -->` marker in the PR body (or the `pr:` field in the Epic
file's `<!-- middle:meta -->`):

```bash
gh pr list --state open --limit 100 \
  --json number,title,headRefName,isDraft,reviewDecision,statusCheckRollup,body,createdAt,updatedAt
```

An Epic with an open draft PR is in-flight; with a ready (non-draft) PR is
`needs-human` (awaiting review).

## Cross-Epic blocked-by

In file mode the "blocked on" relationship is a slug reference in each Epic's meta:

```yaml
<!-- middle:meta
slug: copilot-adapter
blocked-by: [codex-adapter]
-->
```

The graph builder reads `blocked-by` slugs to mark a unit `blocked` until its
blocker Epic closes.

## Write the state body (Phase 6)

Render the composed state model and write it to `state_file` **via
`renderStateIssue`** (atomic write — temp + rename — is the gateway's job). Do not
hand-edit `state_file`.

The run-summary diff against `prior_body` is recorded the same way the dispatcher
records it for a file-backed state — there is no separate GitHub comment, because
the state surface is a file, not an issue.

## What you never do

- Never write `state_file` by hand — only via `renderStateIssue`.
- Never author or edit an Epic file (that's the implementer's / creator's job).
- Never `gh pr create` / `gh pr merge` / `gh pr review`.
- Never touch dispatcher-owned state sections (In-flight, Rate limits, Slots) —
  copy them from dispatcher input verbatim.
