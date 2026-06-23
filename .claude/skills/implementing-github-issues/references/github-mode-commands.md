# implementing-github-issues — GitHub-mode commands

The concrete `gh` incantations for every Epic/plan/sub-issue/conversation operation the skill body refers to mode-agnostically. **GitHub mode** is the default: the Epic is a GitHub issue, its sub-issues are native GitHub sub-issues, and the agent-↔-human conversation flows through issue comments. PRs, reviews, and CI are GitHub-native here too (and identical in file mode).

Throughout, `<epic>` is the Epic's issue number, `<owner>`/`<repo>` the repository.

## Fetch the Epic's context (Phase 1)

```bash
gh issue view <epic> --json number,title,body,labels,assignees,milestone,comments,url
```

Read the body AND every comment — the latest decisions are often in comments.

## Fetch the Epic's sub-issues (the phases of your plan)

GitHub exposes sub-issues via a REST endpoint (`gh` has no flag for it yet):

```bash
gh api /repos/<owner>/<repo>/issues/<epic>/sub_issues \
  --jq '.[] | {number, title, state}'
```

Each open sub-issue is one phase. Work them in dependency order.

## Post the plan to the Epic (Phase 4)

The plan is a comment on the Epic by your account:

```bash
gh issue comment <epic> --body-file planning/issues/<epic>/plan.md
```

The plan-comment guard greps for a comment by your account containing the plan body. If the plan changes, update it:

```bash
gh issue comment <epic> --edit-last --body-file planning/issues/<epic>/plan.md
```

(`--edit-last` has been unreliable in some cases — if it edits the wrong comment, post a fresh comment instead and note the supersession.)

## Close a sub-issue with evidence

When sub-issue N's work is verified and landed, close it with a comment that marks where it landed. The Epic auto-checks it off:

```bash
gh issue close <sub-issue-number> --reason completed \
  --comment "Done in <sha> on PR #<pr> — <area>"
```

## Ask a question / surface a blocker

You don't post the question yourself when headless — write `<worktree>/.middle/blocked.json` and exit. The dispatcher posts the question as an issue comment on the Epic and parks the workflow. The human answers by replying on the issue (or `mm resume <repo> <epic> --answer "…"`).

## File a follow-up as a sub-issue under a parent (Phase 9)

`gh` CLI doesn't have a `--parent` flag, so attach via the sub-issues REST endpoint:

```bash
OWNER=<owner>; REPO=<repo>; PARENT=<parent-issue-number>

# 1. Create the child issue
URL=$(gh issue create --repo $OWNER/$REPO \
  --title "<descriptive title>" \
  --body "$(cat <<'EOF'
**Parent:** #<parent-num> (PR #<pr> surfaced this)

**Context:** <what you saw, where>

**Why a sub-issue and not in-scope:** <e.g., "parallelizable; another agent can pick this up while we work on Phase 2">

**Suggested approach:** <if you have one — otherwise omit>
EOF
)")
CHILD_NUM=$(basename "$URL")

# 2. Look up the child's database id (NOT issue number, NOT node_id)
CHILD_ID=$(gh api /repos/$OWNER/$REPO/issues/$CHILD_NUM --jq '.id')

# 3. Attach as sub-issue under parent.
# CRITICAL: use -F (integer) not -f (string). The endpoint rejects strings:
# `Invalid property /sub_issue_id: "12345" is not of type integer`.
gh api --method POST /repos/$OWNER/$REPO/issues/$PARENT/sub_issues \
  -F sub_issue_id=$CHILD_ID
```

## Create a parent for a natural collection

```bash
PARENT_URL=$(gh issue create --repo $OWNER/$REPO \
  --title "<umbrella concern>" \
  --body "Tracks several related items surfaced during PR #<pr>. See sub-issues.")
PARENT_NUM=$(basename "$PARENT_URL")
# Then file each child as a sub-issue under $PARENT_NUM as above.
```

## File a standalone follow-up (the exception)

Only when the work is a genuinely different workstream. Skip the sub-issue attachment; a "Discovered while working on: #<epic>" line in the body is enough cross-reference:

```bash
gh issue create --repo <owner>/<repo> --title "<descriptive title>" --body "..."
```

## PR / CI operations (identical in file mode)

These are GitHub-native in both modes — listed here for completeness; the same commands appear inline in the skill body.

| Operation | Command |
|---|---|
| Open draft PR up front | `gh pr create --draft --title "..." --body "..."` |
| Update PR body | `gh pr edit <pr> --body-file ...` (or PATCH via `gh api` if the projects-classic GraphQL bug bites) |
| Check mergeability | `gh pr view <pr> --json mergeable,mergeStateStatus` |
| Mark PR ready | `gh pr ready <pr>` |
| Post a file/line review comment | `gh api .../pulls/<pr>/comments -F line=N -f path=... -f body=...` |
| Get PR review comments | `gh api repos/{o}/{r}/pulls/<pr>/comments` |
