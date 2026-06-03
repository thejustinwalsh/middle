# recommending-github-issues — github-mode commands

The concrete state-issue read/write commands for **github mode**: dispatch units
are GitHub issues/Epics, and the state body is the `agent-queue:state` issue.

## Fetch repo state and resolve the Epic graph (Phase 2)

```bash
gh issue list --state open --limit 200 \
  --json number,title,labels,assignees,body,comments,createdAt,updatedAt
gh pr list --state open --limit 100 \
  --json number,title,labels,headRefName,isDraft,reviewDecision,statusCheckRollup,body,createdAt,updatedAt
```

If >200 open issues, filter to `--label agent-queue:eligible` (document the filter
you used in your run-summary comment).

Then resolve the dispatch-unit structure from GitHub's native sub-issue graph:

```bash
gh api /repos/{owner}/{repo}/issues/{n}/sub_issues
```

- An issue with sub-issues is an **Epic** — a dispatch unit.
- An issue with a parent is a **sub-issue** — never a dispatch unit.
- An issue with neither is a **standalone issue** — a one-phase Epic.

Exclude the state issue itself (and any issue carrying `agent-queue:state`).

You may also gauge recent merge cadence:

```bash
git log --oneline -50 main
```

## Read the prior state body (Phase 1)

The dispatcher passes `prior_body` in your prompt. If you need to re-read it live:

```bash
gh issue view <state_issue> --json body --jq '.body'
```

## Write the state body (Phase 6)

```bash
gh issue edit <state_issue> --body-file <generated-body.md>
```

Then post a single diff-summary comment against `prior_body`:

```bash
gh issue comment <state_issue> --body-file <run-summary.md>
```

If zero changes, post `No changes this run.` — confirms the recommender is alive
without polluting the timeline.

## What you never do

- Never `gh issue edit` any issue other than the state issue.
- Never `gh issue comment` on any issue other than the state issue.
- Never add or remove labels (`gh issue edit --add-label` / `--remove-label`).
- Never `gh pr create` / `gh pr merge` / `gh pr review` — you implement and merge
  nothing.
