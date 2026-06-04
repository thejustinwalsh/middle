# Label vocabulary

Every GitHub label middle reads, in one place. middle keys real dispatch behavior off a small set of labels; the rest are grouping metadata. This page is the single source of truth for what each label means — the skills (`creating-github-issues`, `recommending-github-issues`, `implementing-github-issues`) link here rather than restating it.

Each entry gives: what the label means, **who applies it** (operator, a skill, or middle's internals), **what middle does** in response, and **when to use it** (and when not).

The labels fall into five groups:

- **Dispatch unit** — `epic`
- **Dispatch gates** — `approved`, `needs-design`, `blocked`, `wontfix`
- **Adapter routing** — `agent:claude`, `agent:codex`
- **Internals & eligibility** — `agent-queue:state`, `agent-queue:eligible`
- **Grouping metadata** — `dogfood`, `bootstrap`, `housekeeping`, `phase:N`

## Dispatch unit

### `epic`

- **Means:** this issue is a **dispatch unit** — middle works it as one Epic → one branch → one PR, with its open sub-issues as the phases.
- **Who applies it:** the `creating-github-issues` skill stamps it on every parent it files; an operator adds it to a hand-filed parent.
- **What middle does:** the recommender uses `epic` as the **discriminator** for what to rank. A parent issue *without* `epic` is invisible to the recommender — it won't appear in Ready, Needs human input, Blocked, or even Excluded; it just vanishes. (The recommender surfaces this case in `## Excluded` with a `missing 'epic' label` hint rather than dropping it silently — the failure mode that cost 90 minutes on Epic #190.)
- **When to use:** every Epic (every parent, and every standalone issue you want dispatched). Sub-issues do **not** need it — they inherit ranking from the parent.

## Dispatch gates

### `approved`

- **Means:** authorize the agent to make a best-judgment call past the **complexity ceiling** instead of pausing.
- **Who applies it:** an operator/maintainer, manually. Never a skill — it's a dispatch decision, not metadata about the work.
- **What middle does:** complexity is the branching factor of an unresolved design decision (how many candidate implementations you'd have to build to decide). When a decision needs more candidate forks than `complexity_ceiling`, the agent normally pauses that sub-issue and escalates. With `approved` on the Epic, the agent may instead proceed on best judgment when it resumes.
- **When to use:** on an Epic you expect to brush against the complexity ceiling and you trust the agent to choose. Don't use it to silence a genuinely under-specified Epic — resolve the scope instead.

### `needs-design`

- **Means:** this issue needs an explicit design decision resolved before it can be implemented. **The most expensive label in the vocabulary** — it removes the issue from auto-dispatch entirely until a maintainer un-labels it.
- **Who applies it:** the backlog-audit cron (when an issue's acceptance criteria fail the integration rubric) or an operator. A maintainer un-labels it to restore eligibility.
- **What middle does:** the recommender refuses to classify the Epic as `ready` while it carries `needs-design`, and it is out of scope for the integration rubric.
- **When to use:** only when you can name **≥2 specific candidate approaches** *and* say why building each as a worktree POC (the `implementing-github-issues` "Architectural forks" mechanic) wouldn't decide between them. "More work than I want," "I want human ack first," or "feels designy" are **not** reasons — if the body has implementation verbs with concrete file paths, it's `enhancement`, and the implementer forks-and-decides.

### `blocked`

- **Means:** this Epic is waiting on something else — most often another open Epic that must close first.
- **Who applies it:** an operator, or the recommender as it classifies (it names the blocker explicitly).
- **What middle does:** the recommender refuses `ready` while `blocked` is present and reports the unit under `## Blocked` with the blocker named. The label also takes the issue out of the integration rubric.
- **When to use:** when an Epic genuinely cannot proceed until a concrete blocker clears. Name the blocker in the body so the human knows what unblocks it.

### `wontfix`

- **Means:** this issue is intentionally not going to be worked — out of scope, deprecated, superseded.
- **Who applies it:** an operator, manually.
- **What middle does:** the recommender excludes it from `ready` (the same gate as `needs-design`/`blocked`), and it is out of the integration rubric.
- **When to use:** to keep a deliberately-declined issue visible with its reason, rather than dispatching it.

## Adapter routing

### `agent:claude`

- **Means:** pin this Epic to the **Claude** adapter, overriding the repo default.
- **Who applies it:** an operator, manually (a dispatch decision).
- **What middle does:** adapter selection is `agent:<name>` label → else `config.default_adapter` → with a portable task, switch away from a rate-limited adapter; otherwise auto-dispatch skips the Epic until the adapter resets.
- **When to use:** when an Epic needs a specific agent's capabilities, or to balance load across adapters.

### `agent:codex`

- **Means:** pin this Epic to the **Codex** adapter, overriding the repo default.
- **Who applies it:** an operator, manually.
- **What middle does:** same routing as `agent:claude` — the `agent:<name>` label wins over `config.default_adapter`.
- **When to use:** as for `agent:claude`, when Codex is the agent you want for this Epic.

## Internals & eligibility

### `agent-queue:state`

- **Means:** this issue **is the dispatcher's state issue** — the single issue holding the ranked dispatch plan and needs-human digest — not a dispatch unit.
- **Who applies it:** middle's internals only (`mm init` creates the label and the state issue). `mm uninit` deliberately preserves the label.
- **What middle does:** the recommender treats the `agent-queue:state` issue as its own surface and never ranks it as an Epic.
- **When to use:** never apply it by hand. It's middle-internal bookkeeping.

### `agent-queue:eligible`

- **Means:** in a large issue tracker, mark which issues are eligible for the recommender to consider.
- **Who applies it:** an operator (or internals) on large repos.
- **What middle does:** when a repo has **more than 200 open issues**, the github-mode recommender filters the backlog to `--label agent-queue:eligible` and documents the filter in its run summary, so a huge tracker doesn't blow the ranking budget.
- **When to use:** on repos large enough that you want to scope what middle ranks. On a small tracker it's unnecessary — every open Epic is considered.

## Grouping metadata

### `dogfood`

- **Means:** work that flows through middle itself once dogfooding starts (a workstream middle dispatches and builds).
- **Who applies it:** the `creating-github-issues` skill, when the plan calls for it.
- **What middle does:** nothing in dispatch — it's used for filtering and grouping in the dashboard and issue browse.
- **When to use:** on workstream issues that are part of the active middle-dispatched build, to distinguish them from foundational or external work.

### `bootstrap`

- **Means:** pre-dogfooding, foundational work — setup and infrastructure that must land before dogfooding can begin.
- **Who applies it:** the `creating-github-issues` skill, when the plan calls for it.
- **What middle does:** grouping/filtering only.
- **When to use:** on prerequisites to dogfooding that aren't themselves part of the active dispatched workstream.

### `housekeeping`

- **Means:** infrastructure and repo hygiene — CI, tooling, dependency bumps, lint config — not product feature work.
- **Who applies it:** the `creating-github-issues` skill, when the plan calls for it.
- **What middle does:** grouping/filtering, and it takes the issue out of the **integration rubric** — a housekeeping issue isn't a feature, so it isn't required to carry an integration acceptance criterion.
- **When to use:** on non-feature maintenance work (e.g. a CI workflow, a LICENSE file, a dependency update).

### `phase:N`

- **Means:** phase grouping for a build spec — `phase:0`, `phase:1`, … — organizing related work into the spec's logical phases.
- **Who applies it:** the `creating-github-issues` skill, when the spec provides an explicit phase breakdown.
- **What middle does:** dashboard and status grouping only.
- **When to use:** when the spec hands you a phase structure worth preserving on the issues.

## See also

- [Operator guide](operator.md) — the `mm` commands that act on these labels.
- [Bootstrap reference](bootstrap.md) — what `mm init` stamps into a repo (including the `agent-queue:state` label).
