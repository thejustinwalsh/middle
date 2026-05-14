---
name: implementing-github-issues
description: Use when the user provides a GitHub issue number or URL and asks to implement it end-to-end. Triggers include "implement issue #123", "work on this issue: <url>", "pick up #45", "ship issue 78". Drives the full workflow — fetch issue, research, plan, draft PR, iterate phases on one branch with verification, decisions log, fork-and-evaluate when decisions are genuinely unclear, follow-up issues, mark ready for human review.
allowed-tools: Bash(gh:*), Bash(git:*), Bash(pnpm:*), Bash(mkdir:*), Read, Write, Edit, Skill
---

# Implementing GitHub Issues

End-to-end workflow for taking a GitHub issue from "assigned" to "PR open with verification evidence, marked ready for human review." All phases of one issue land on **one branch** and **one PR**; the PR is the long-lasting context for the workstream.

## Core principles

**The code shows WHAT. The PR explains WHY.** Code comments are reserved for non-obvious constraints. Reasoning, alternatives considered, and tradeoffs go in the **decisions log** (`planning/issues/<num>/decisions.md`), then get distilled into PR review comments and the PR description.

**Iteration > theory.** Branches are sandboxes; you don't know the reality of a plan until you commit work to it. Build to learn, don't theorize to plan. Three concrete forms:

- **Verification gaps → build the verification.** Write the test, run the probe, drive the dev server with `agent-browser`. Don't wait for human review to learn whether the work is correct.
- **Phase verified → start the next phase on the same branch.** All phases of one issue land on one branch and one PR; the PR is long-lasting context. Don't gate on merge between phases. Don't open a new PR per phase.
- **Architectural decision unclear after consulting CLAUDE.md / repo skills / project docs → worktree both options.** Implementations resolve ambiguity faster than debate. Only when both built artifacts come back genuinely tied do you stop and elevate for manual review.

**Hard rule: the skill never merges the PR.** The PR is the long-lasting context for the workstream; merging is the human's final gate. The terminal state is "PR open, all phases verified, follow-ups filed, marked ready for review."

## When to use

- User pastes an issue number (`#123`), URL (`https://github.com/.../issues/123`), or says "implement #N"
- User asks to "pick up", "work on", "ship", or "close out" an issue
- The work is scoped by an existing GitHub issue (not a fresh feature request — for those, use `superpowers:brainstorming` first)

**Don't use for:**
- Drive-by fixes with no associated issue (just open a PR)
- Issues that are actually discussions/questions (reply on the issue instead)
- Cross-repo or epic-level work spanning multiple issues (split first)

## Workflow

```dot
digraph workflow {
  rankdir=TB;
  setup [label="1-5. Fetch, research, plan,\ncomment plan, worktree"];
  draftpr [label="6. Open draft PR up front\n(long-lasting context)"];
  impl [label="7. Implement next phase\n+ append to decisions.md"];
  unclear [label="Architectural decision\nunclear after\nCLAUDE.md/skills/docs?", shape=diamond];
  fork [label="Worktree A + B from current branch\nimplement minimal POC, evaluate,\nfold winner via cherry-pick or merge"];
  tied [label="Genuinely tied?", shape=diamond];
  verify [label="Verify the phase\n(tests, agent-browser,\nbuild artifacts)"];
  more [label="More phases\nin plan?", shape=diamond];
  finalize [label="8-9. Distill PR review comments,\nfile follow-up sub-issues"];
  gate [label="Acceptance gate:\nevery criterion met or\nstakeholder-deferred?", shape=diamond];
  ready [label="10. Mark PR ready\nfor human review (STOP)"];

  setup -> draftpr -> impl -> unclear;
  unclear -> fork [label="yes"];
  unclear -> verify [label="no"];
  fork -> tied;
  tied -> impl [label="no — winner clear"];
  tied -> ready [label="yes — escalate"];
  verify -> more;
  more -> impl [label="yes — same branch"];
  more -> finalize [label="no"];
  finalize -> gate;
  gate -> ready [label="yes"];
  gate -> impl [label="no — finish or get consent"];
}
```

## Verification mindset

When you can't tell whether a phase's work is correct, the first instinct is **"what can I build to verify this?"** — not "let me wait for human review." Tools at your disposal (per project; not all projects have all of these):

| Verification need | Tool |
|---|---|
| Logic correctness | Vitest unit tests |
| User-visible behavior | Playwright functional tests |
| Visual / interactive verification | `agent-browser` skill (if installed) — drive the dev server, take screenshots, click through |
| Live-system invariants only emergent in full play | Vitexec integration tests (see "Integration test gate" below) |
| Build artifacts | Inspect `dist/` for expected files, sizes, content; grep generated CSS/JS |
| API endpoints | curl against dev server; assert response shape |
| Type correctness | `pnpm typecheck` (or whatever the project exposes) |
| Console / network errors | `agent-browser` console reads, network logs |

When verification reveals an actual problem, fix it. When verification proves the work, **document the verification approach in the PR** (commands, screenshots, assertion snippets) so reviewers can re-run.

The trap to avoid: framing "I'm not sure this works" as a reason to bail out of the plan. Most uncertainty resolves with 10 minutes of test-writing or a 30-second `agent-browser` run. The plan is the commitment; verification is how you keep yourself honest.

### Integration test gate

If the project ships a vitexec-based integration suite, **integration tests are evidence-of-completeness alongside unit tests** for any change touching simulation pipelines, full-system invariants, or wall-clock-dependent behavior (timing, animation, physics, agentic AI).

You'll know a project has one when its `package.json` exposes a separate script (commonly `test:integration` or similar) and there's a sibling vitest config (often `vitest.integration.config.ts`). The integration suite is excluded from the default unit-test runner because each test boots a real browser and observes the running app for tens of seconds; running them on every commit isn't viable.

When you finish a phase that touched the simulation pipeline:
1. Run the unit tests (`pnpm test`). All must pass.
2. Run the integration suite (`pnpm test:integration` or equivalent). All must pass.
3. If the change introduces a new invariant that only emerges in full play, ADD a probe + harness for it in the same commit as the fix. The test IS the verification evidence.

If the project DOESN'T have a vitexec suite and you keep building one-off probes during debugging, that's a signal to invest in scaffolding the suite as part of the workstream rather than re-discovering the pattern in `/tmp` every session.

**See [references/vitexec-integration-suite.md](references/vitexec-integration-suite.md)** for: the live-debugging inner loop with vitexec, the fold-back checklist (one-off probe → committed regression test), the suite layout convention, the probe/harness/runner contracts, the `--gpu` requirement, the game-side-counters technique, and the suite-from-scratch bootstrap guide.

## Architectural forks (only when decisions are genuinely unclear)

You don't fork for every architectural decision. Forks are expensive (two implementations, evaluation overhead). Reserve them for decisions where:

1. The decision affects the implementation in load-bearing ways (not "which CSS class name")
2. CLAUDE.md / repo skills / project docs don't pick a winner
3. Project rules + patterns + fitness tests + perf considerations don't pick a winner

If those criteria are all true, the decision is worth resolving via implementation rather than debate.

### Fork mechanics

```bash
# 1. Worktree both options off the current branch
git worktree add .claude/worktrees/<branch>-fork-A -b <branch>-fork-A
git worktree add .claude/worktrees/<branch>-fork-B -b <branch>-fork-B

# 2. Implement a minimal proof-of-concept on each
#    Each should be small enough to evaluate in 1-2 hours, not days.

# 3. Open both as draft PRs targeting main, link from the core PR description:
#    > **Architectural fork in progress:** evaluating A (#PR-A) vs B (#PR-B).
#    > Decision criteria: <list rules/patterns/fitness signals being checked>.

# 4. Evaluate against project rules + patterns + fitness tests + perf.
#    The CLAUDE.md / repo skills / docs you already consulted are the criteria.
#    Run real tests on each branch; measure bundle size, perf, code clarity.

# 5. Winner clear:
#    - Cherry-pick the winning commits onto the core branch (preferred — works
#      even if the core branch advanced during evaluation)
#    - Or `git merge` the winning branch if the core branch hasn't moved
#    - Close both fork PRs (winner: work is in core; loser: discarded)
#    - Delete both fork branches and worktrees

# 6. Genuinely tied → STOP. Append the comparison to the core PR's description
#    (keep it draft) and elevate for manual review with the fork PR links and
#    the evaluation matrix.
```

**Default assumption during a fork:** you don't iterate on the core branch until the decision resolves. That keeps the fold-back clean (a `git merge --ff-only` works). If you can't sit still and want to continue unrelated work on the core branch, switch to cherry-pick — it copes with a moved core.

**Once chosen, collapse and clean up.** Don't leave the losing branch hanging "just in case." Delete the worktree, delete the branch, close the PR. Forks are disambiguation, not insurance.

## Phase 1 — Fetch issue context

```bash
gh issue view <num> --json number,title,body,labels,assignees,milestone,comments,url
```

Read the body AND every comment. The latest decisions are often in comments, not the description. Note:
- Acceptance criteria (explicit or implicit)
- Linked issues / PRs / discussions
- Constraints called out by the reporter
- Anyone @-mentioned who might be a stakeholder

## Phase 2 — Research the codebase

Before drafting a plan, ground yourself:
- Grep for any symbols/files the issue names
- Read the surrounding code, not just the named file
- Check `git log` on relevant files for recent context
- Read the relevant `CLAUDE.md` (root + nested) — these are the source of architectural patterns and conventions
- For broad investigations, dispatch `Explore` subagent (50-100x context savings)

**STOP if:** The issue is ambiguous, the acceptance criteria are unclear, or the research reveals the issue's premise is wrong. Comment on the issue with your questions and wait, rather than guessing.

## Phase 3 — Draft a lightweight plan

Write to `planning/issues/<num>/plan.md`:

```markdown
# Issue #<num>: <title>

**Link:** <issue url>
**Branch:** <branch-name>

## Goal
<1-2 sentences — what shipping looks like>

## Approach
<3-6 bullets — the strategy, not a step-by-step>

## Phases
1. <name> — <one-line scope>
2. <name> — <one-line scope>
N. ...

## Files likely to change
- `path/to/file.ts` — <what changes>
- ...

## Out of scope
- <things that look related but aren't part of this issue>

## Open questions
- <anything you'd ask the reporter if they were available>
```

**Lightweight means lightweight.** If you're writing more than ~100 lines for a multi-phase plan, you're either over-planning or the issue should be split. For genuinely complex multi-day work, use `superpowers:writing-plans` and link from the issue comment.

## Phase 4 — Post plan as issue comment

```bash
gh issue comment <num> --body-file planning/issues/<num>/plan.md
```

This is non-negotiable. The plan-as-comment serves three purposes:
1. The reporter / stakeholders can correct your direction before you write code
2. It's discoverable from the issue itself (not buried in a branch)
3. It creates a public commitment that disciplines the work

If you skip this step, you've broken the contract of this skill.

## Phase 5 — Create worktree branch

**REQUIRED SUB-SKILL:** Use `superpowers:using-git-worktrees` for branch isolation.

Branch naming: derive from issue title, kebab-case, prefixed with issue number if convention dictates. Check recent branches with `git branch -a | head` for the local convention.

This branch is the spine of the workstream. All phases land on it. Only architectural forks branch off it (and fold back into it).

## Phase 6 — Open the PR up front (as a draft)

The PR is opened *before* implementation, not after. It's the long-lasting context for the entire workstream — phases push commits to it; reviewers can subscribe; cross-references from sub-issues and architectural forks have a stable target.

```bash
gh pr create --draft \
  --title "<conventional commit title>" \
  --body "$(cat <<'EOF'
## Summary
Closes #<num>

🚧 **Draft — work in progress.** See plan.md for the full multi-phase scope.

## Plan
<copy from plan.md, or link to the issue comment with the plan>

## Status
- [ ] Phase 1: <name>
- [ ] Phase 2: <name>
- [ ] Phase N: <name>

## Verification evidence
<populated as each phase verifies>

## Decisions
See `planning/issues/<num>/decisions.md` (will be distilled into per-line review comments before final review).
EOF
)"
```

The PR title follows Conventional Commits (per project CLAUDE.md): `feat(scope): ...`, `fix(scope): ...`, etc.

## Phase 7 — Implement the next phase (loop)

For each phase in the plan, repeat:

### 7a. Implement
Atomic commits per logical change. **We rebase, we don't squash.** Keep history clean and meaningful — per-change commits are part of the project's archival record.

### 7b. Append to decisions log
Every time you face a decision worth more than two lines of explanation, append to `planning/issues/<num>/decisions.md`:

```markdown
## <Short decision title>
**File(s):** `path/to/file.ts:123`
**Date:** YYYY-MM-DD

**Decision:** <what you chose>
**Why:** <reasoning, tradeoffs, alternatives considered>
**Evidence:** <link to docs, prior art in codebase, benchmark, etc.>
```

### 7c. Architectural fork? Only when genuinely unclear.
Consult CLAUDE.md / repo skills / project docs first. If they decide it, just decide it. Otherwise see the **Architectural forks** section above.

### 7d. Verify the phase
Per the **Verification mindset** section above. Tests, `agent-browser`, build-artifact inspection, dev-server probes — whatever fits the work. Capture verification evidence in commit messages and/or in `decisions.md`.

**Integration test gate** (when the project has a vitexec suite — see "Integration test gate" subsection above): if the phase touched the simulation pipeline, full-system invariants, or wall-clock-dependent behavior, run the integration suite and require green BEFORE moving to 7e. New invariants that only emerge in full play should ship with a new probe + harness in the same commit — the test IS the verification evidence. A green unit suite + missing integration coverage is not enough for items in this category.

### 7e. Update the PR description
Tick the phase checkbox in the Status section. Add verification evidence under that phase. Push.

### 7f. Continue to the next phase on the same branch.
Don't open a new PR. Don't wait for human review between phases. The PR is long-lasting context; phases accumulate on it.

### What goes in the decisions log vs. a code comment

| Type of context | Goes where |
|---|---|
| Why this approach over the obvious one | decisions.md |
| Tradeoff between perf and readability | decisions.md |
| Alternative APIs we considered and rejected | decisions.md |
| Hidden constraint (e.g., "WebGPU requires X to be aligned to 16 bytes") | code comment |
| Subtle invariant a reader would miss | code comment |
| Workaround for a specific upstream bug with link | code comment |
| "This is used by feature X" | NEITHER (PR description if needed) |

**Rule of thumb:** If removing the code comment wouldn't confuse a future reader of *just this code*, it doesn't belong in the code. It belongs in the decisions log → PR review comment.

### Don't bloat code with reasoning

If you catch yourself writing a 5+ line comment explaining a choice, stop. Write a 1-line comment ("see PR review for rationale") and move the body into decisions.md.

## Phase 8 — Distill decisions.md into PR review comments

When all phases are verified, walk through `decisions.md` and post each entry as a **file/line review comment** on the PR — not as a top-level PR comment.

```bash
PR_NUM=<n>
COMMIT=$(gh pr view $PR_NUM --json commits --jq '.commits[-1].oid')

gh api \
  --method POST \
  -H "Accept: application/vnd.github+json" \
  /repos/{owner}/{repo}/pulls/$PR_NUM/comments \
  -f body="$(cat decision-body.md)" \
  -f commit_id="$COMMIT" \
  -f path="path/to/file.ts" \
  -F line=123 \
  -f side=RIGHT
```

For multiple comments, batch into a single review:

```bash
gh api --method POST /repos/{owner}/{repo}/pulls/$PR_NUM/reviews \
  -f event=COMMENT \
  --input review.json
```

where `review.json` has `{"comments": [{"path": "...", "line": N, "body": "..."}, ...]}`.

The `decisions.md` file stays in the branch as the source of truth.

## Phase 9 — Decide what's a follow-up, file with proper hierarchy

If during implementation you spot:
- Code that's broken/stale but out of scope
- Missing tests in adjacent code
- Violations of project conventions you didn't introduce
- Performance concerns you noticed but didn't fix
- API surface that should be reconsidered

…before reaching for `gh issue create`, walk this decision tree:

```dot
digraph followup_decision {
  spot [label="Spotted something\nout of this PR's scope"];
  scope [label="Will this be tackled in\na future phase of the\ncurrent issue's workstream?", shape=diamond];
  note  [label="Don't file. Note in plan.md\nas in-scope future work."];
  parent [label="Does a parent issue\nalready track this kind\nof work?", shape=diamond];
  natural [label="Are there ≥2 related\nthings naturally grouped\nunder a missing parent?", shape=diamond];
  filesub [label="File as sub-issue\nunder existing parent"];
  createparent [label="Create the parent first,\nthen file each as sub-issues"];
  filestandalone [label="File standalone\n(truly parallelizable\nor new workstream)"];

  spot -> scope;
  scope -> note [label="yes"];
  scope -> parent [label="no"];
  parent -> filesub [label="yes"];
  parent -> natural [label="no"];
  natural -> createparent [label="yes"];
  natural -> filestandalone [label="no"];
}
```

**Default to parent/sub-issue hierarchy.** Standalone issues are the *exception*, not the rule. They're appropriate only when the work is genuinely a different workstream (e.g., a workspace-wide dependency bump that affects packages outside the current issue's surface area).

**Don't file what you're going to tackle yourself.** If a "stumbling point" surfaces something you'll fix in Phase 2 of the same plan, it's a TODO in `plan.md`, not a GitHub issue. Filing creates noise and false signal that the work is parallelizable.

### Discovery follow-ups vs. punted-scope sub-issues

A sub-issue is appropriate for items you **discovered** during implementation that the issue's acceptance criteria didn't anticipate, and that are genuinely parallelizable. A sub-issue is **never** appropriate for items already listed in the issue body, the agreed `plan.md`, or stakeholder comments. Those are scope; they're delivered or the PR isn't ready.

The test: search the issue body, `plan.md`, and issue/PR comments for the candidate item. If it's there, it's scope (a plan TODO if it spans phases — but not a separable sub-issue). If it's not there, it's discovery (sub-issue or plan TODO depending on parallelizability).

**Common rationalizations to refuse:**
- "It's parallelizable so a sub-issue is fine." Parallelizability is a property of the work, not a license to fork agreed scope.
- "The core is done; this is polish." If the plan listed it as an acceptance criterion, it isn't polish — it's scope under a flattering name.
- "Filing it captures it for later." `plan.md` captures it for later. Sub-issues advertise parallelizability, which is false signal when the work was always in scope.

If you genuinely believe an acceptance-criterion item should be deferred, ask the stakeholder in an issue/PR comment first and **wait for written authorization** before rewriting scope. Stakeholder consent in writing → legitimate deferral. Unilateral PR-description rewrite → scope cut, and Phase 10's acceptance gate will (and should) catch it.

### Filing a sub-issue under an existing parent

GitHub supports native sub-issues via REST API. `gh` CLI 2.67+ doesn't have a `--parent` flag yet, so use `gh api`:

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

### Creating a parent for a natural collection

If you spotted ≥2 related items and there's no parent issue yet, create the parent FIRST, then file each item as a sub-issue under it. The parent issue body should describe the umbrella concern; sub-issue bodies stay focused on their specific scope.

```bash
PARENT_URL=$(gh issue create --repo $OWNER/$REPO \
  --title "<umbrella concern>" \
  --body "Tracks several related items surfaced during PR #<pr>. See sub-issues.")
PARENT_NUM=$(basename "$PARENT_URL")
# Then file each child as a sub-issue under $PARENT_NUM as above.
```

### Standalone issue (the exception)

Only when the work is genuinely a different workstream — affects packages outside the current issue's surface area, or is a separate feature/initiative entirely. File without `--parent` linkage; the body's "Discovered while working on:" line is enough cross-reference.

### PR description cross-linking

In the PR's "Follow-up issues" section, list each item with its parent context:

```markdown
## Follow-up issues
- #N1 (sub-issue of #PARENT) — <one-liner>
- #N2 (sub-issue of #PARENT) — <one-liner>
- #N3 (standalone) — <one-liner; explain why standalone>
```

**Do not silently absorb tech debt into your PR scope.** And conversely: **do not noisily file every adjacent task as a separate issue.** Both are scope-discipline failures in opposite directions; the parent/sub-issue hierarchy is what keeps them honest.

## Phase 10 — Mark the PR ready for review

### 10a. Acceptance gate (mandatory)

Before transitioning the PR out of draft, walk **every acceptance criterion** from the issue body, `plan.md`, and stakeholder comments. For each, evidence one of:

- ✅ **Met** — link the file/line, screenshot, test output, or built artifact that proves delivery.
- ✅ **Stakeholder-deferred** — link to the issue/PR comment from the reporter or maintainer authorizing the deferral. *Their* consent is the gate; not yours.

If even one criterion has neither evidence, **the PR is not ready.** Stay in draft, finish the work (or request authorization in a comment and wait for written approval), then return to this gate. Do not proceed to 10b until the gate is open.

A self-test: if you find yourself reaching for qualifiers — *"Phase 3 (core)"*, *"Phase 2 (foundation)"*, *"MVP version"*, *"(initial)"* — you are rationalizing a scope cut. The plan didn't say "core" or "MVP" or "initial." Those qualifiers get added at offramp time so unfinished work reads as complete. Strip the qualifier; if the original phase isn't complete by the plan's criteria, the gate is closed.

Filing remaining acceptance items as sub-issues is **not** a substitute for delivery. Sub-issues are for items the plan didn't anticipate (see Phase 9's "Discovery follow-ups vs. punted-scope sub-issues"). Punting agreed scope through sub-issues is the failure mode this gate exists to prevent — and the previous agent's PR ending up reverted from "ready" back to "draft" is the cost of getting it wrong.

Render the gate result as a short acceptance-evidence table in the PR description (or in a dedicated review comment) so the human reviewer can audit it without re-deriving it.

### 10b. Finalize PR description and mark ready

```bash
# Final PR description sweep — make sure the running summary is final-form.
# Status section: all phases checked. Verification evidence: complete per phase.
# Stumbling points + Suggested CLAUDE.md updates: filled in.
# Acceptance evidence table: every criterion met or stakeholder-deferred (10a).
gh pr edit <pr-num> --body-file <final-body>

# Mark the PR ready for review (transitions out of draft)
gh pr ready <pr-num>
```

The final PR description should include:

```markdown
## Summary
Closes #<num>

<2-4 sentences — what shipped and why it matters>

## What changed
- `path/to/file.ts` — <change in user-visible terms>
- ...

## Why these changes
<the central reasoning, drawn from decisions.md highlights — but inline, not as bullet links>

## Verification
<commands, screenshots, test output — whatever proves it works for each phase>
- Phase 1: <evidence>
- Phase 2: <evidence>
- ...

## Stumbling points
<honest list of things that took longer than expected, blind alleys, surprises>

## Suggested CLAUDE.md updates
<if any stumbling point would have been avoided by clearer project docs, propose specific edits here>

## Architectural forks (if any)
- <#PR-A vs #PR-B>: chose A because <evidence-driven reasoning>; closed B
- (or) genuinely tied, escalated for manual review

## Follow-up issues
- #N1 (sub-issue of #PARENT) — <one-liner>
- #N2 (standalone) — <one-liner; explain why standalone>

## Out of scope
<anything from the plan's "Out of scope" that's worth restating>
```

**Stop here.** The skill does not merge the PR. The human reviews and merges; that's the final gate.

## Quick reference

| Step | Command |
|---|---|
| Fetch issue | `gh issue view <n> --json number,title,body,labels,comments,url` |
| Comment plan | `gh issue comment <n> --body-file planning/issues/<n>/plan.md` |
| Open draft PR up front | `gh pr create --draft --title "..." --body "..."` |
| Update PR body | `gh pr edit <n> --body-file ...` (or `gh api PATCH ...` if blocked) |
| Mark PR ready | `gh pr ready <n>` |
| Verify visually | `agent-browser` skill (Skill tool) |
| Verify functionally | `pnpm test`, `pnpm typecheck`, `pnpm build` (per project) |
| Worktree fork option | `git worktree add .claude/worktrees/<branch>-fork-A -b <branch>-fork-A` |
| Review comment | `gh api .../pulls/<n>/comments -F line=N -f path=... -f body=...` |
| File sub-issue under parent | `gh issue create … && gh api …/issues/$PARENT/sub_issues -f sub_issue_id=$ID` (see Phase 9) |
| File standalone follow-up | `gh issue create --title "..."` (only if truly parallel/new workstream) |
| Get PR comments | `gh api repos/{o}/{r}/pulls/<n>/comments` |

## Red flags — STOP and self-correct

These thoughts mean you're about to violate the workflow:

| Thought | Reality |
|---|---|
| "Let me theorize this in the plan instead of building it" | Build to learn. Plans are starting points, not commitments. The implementation reveals what the plan can't. |
| "I can't tell if this works without manual review" | Build the verification. Vitest, Playwright, `agent-browser`, dev-server probes. 10 minutes of test-writing beats hours of review-waiting. |
| "Phase 1 is in review, I'll wait before starting Phase 2" | All phases land on the same branch. Push Phase 2 commits to the same PR. The PR is long-lasting context, not a one-shot. |
| "The next phase has multiple entry points — let me ask which order the user prefers" | The plan already orders the work. Pick the first plan item and start; re-order only if the implementation reveals reality demands it. Sequencing questions disguised as collaboration are still hesitation. The plan IS the answer. |
| "I'll open a new PR per phase" | One PR per workstream. New PRs only for architectural forks (and they fold back into the core PR). |
| "Let me debate A vs B in the plan" | Have you checked CLAUDE.md / repo skills / project docs? If they don't decide, worktree both options. If both built artifacts come back tied, *then* escalate. |
| "Once I pick a fork, I'll keep the loser branch around 'just in case'" | Delete it. Forks are disambiguation, not insurance. |
| "I'll squash these atomic commits into one" | Don't. Rebase, keep history atomic. The repo convention is meaningful per-change commits. |
| "I'll merge the PR myself when verification passes" | Never. Human review is the final gate. The skill stops at "PR ready for review." |
| "Build passed, the work must be correct" | Build success ≠ feature correctness. Especially for UI work — type checks and unit tests don't tell you if the new layout actually renders. Use `agent-browser` for visual verification on UI changes. |
| "I'll skip the issue comment, the plan is obvious" | The plan-as-comment is the contract. Post it. |
| "I'll just add a 10-line comment explaining this" | Decisions log → PR review comment. Code stays clean. |
| "I'll fix this small adjacent thing while I'm here" | File a follow-up. Keep scope tight. But check first: is it Phase-N work for the same parent? Then it's a plan TODO, not a new issue. |
| "Every TODO becomes its own GitHub issue" | Most belong as plan notes for future phases of the same workstream. Standalone issues are the exception, not the default. |
| "I'll file these standalone — they're 'tech debt'" | If they share a theme and have no parent, *create the parent first*, then file as sub-issues. Standalone is reserved for genuinely cross-workstream work. |
| "Phase N (core) is complete; the rest can be sub-issues" | If the plan's Phase N acceptance criteria aren't all met, Phase N isn't complete. Adding qualifiers to phase names ("core", "initial", "foundation", "MVP") is the linguistic tell of a unilateral scope cut. Strip the qualifier; stay in draft until the actual phase is done. |
| "These remaining acceptance items are parallelizable, sub-issues are appropriate" | Acceptance criteria from the plan were never parallelizable scope — they're agreed deliverables. Sub-issues are for items the plan didn't anticipate. Filing the remainder as sub-issues advertises false parallelism and ships the issue partially done. |
| "The PR is feature-complete enough to mark ready" | "Enough" is the rationalization. The PR is ready when *all* acceptance criteria are met or *all* deferrals carry stakeholder authorization in writing — not before. Phase 10's acceptance gate forbids the soft exit. |
| "The PR description can just be the commit list" | Full report or it didn't happen. Why > what. Include verification evidence per phase. |
| "No need for stumbling points — it went fine" | Then your "Stumbling points" section is "None." But write the section. |
| "Decisions log is overkill for this issue" | It's overkill *until* you need to write the PR review comments. Then it's the source. |
| "Initial plan turned out wrong, no need to update" | Edit `plan.md` and edit the issue comment (`gh issue comment --edit-last`). The plan must reflect reality. |

## Common mistakes

**Skipping research before planning.** A plan written without grounding is fiction. Spend 5-15 minutes in the codebase first — and read the relevant CLAUDE.md files. They're the source of architectural patterns and conventions and they often resolve "decisions" before you have to fork.

**Decisions log written after the fact.** Write entries as you decide, not at PR time. Reconstructed reasoning is reconstructed.

**PR review comments duplicated as code comments.** Pick one. The PR review comment is the canonical home for "why this approach"; the code comment is for "this hidden invariant matters."

**Follow-up issues that are too vague.** "Refactor X" is not a follow-up issue. "Extract Y from X because Z couples them in a way that broke during this PR" is.

**No CLAUDE.md update suggestions.** If something tripped you up, it'll trip the next agent. Propose edits in the PR — the maintainer accepts or rejects.

**Forking on every architectural choice.** Forks are expensive. Reserve them for genuinely unclear decisions where rules/patterns/fitness/perf don't pick a winner. Most decisions are decided by reading CLAUDE.md.

**Verification skipped because "the build passed."** Build success ≠ feature correctness. Especially for UI work — type checks and unit tests don't tell you if the new layout actually renders correctly. Use `agent-browser` for visual verification on UI changes.

**Bailing on the plan when iteration would resolve it.** Hesitation is not a quality principle. Iteration is. Commit to the plan, react to what builds, adjust the plan when reality demands it. The branch is the sandbox; use it.

**Marking PR ready with unmet acceptance criteria.** The skill terminates at "PR ready for review" only when the agreed scope is delivered or every deferral carries stakeholder authorization in an issue/PR comment. Filing sub-issues for criteria you skipped is not delivery — it's a unilateral scope cut. Phase 10's acceptance gate (10a) is the explicit checkpoint that prevents this; do not bypass it.

**Inventing scope qualifiers to justify offramps.** Phrases like "Phase 3 (core)", "Phase 2 (foundation)", "MVP version", "(initial)" don't appear in the agreed plan — they get added at offramp time so unfinished work reads as complete. If you reach for a qualifier, you're rationalizing. Strip it and ask: is the phase actually done by the plan's criteria? If not, stay in draft.

## Files this skill creates

```
planning/issues/<num>/
  plan.md         # committed; mirrors the issue comment
  decisions.md    # committed; source for PR review comments
```

Both files live with the branch and get merged with the PR. They're project-archive evidence of how the issue was resolved.

## Running under middle (headless dispatch)

Everything above describes the skill running interactively. When **middle-management** (`mm`) dispatches you, you run **headless in a tmux session** — there is no human in the loop during the run, you execute until you exit, and middle's dispatcher, hooks, and mechanical gates observe and enforce your work. The phases above still apply; this section is the delta. Where it says "overrides Phase N," follow this instead.

### You are already in a prepared worktree (overrides Phase 5)

The dispatcher created your worktree and branch and spawned you inside it. Do **not** run `git worktree add` or create another branch — you're already on the workstream's branch. Confirm your location (`git branch --show-current`, `pwd`) and start at Phase 6 (or resume mid-workstream — see below). Architectural forks still branch off your current branch as normal.

### Asking a question = write `.middle/blocked.json` and exit (overrides Phase 2's "comment and wait")

You cannot "comment on the issue and wait" — headless, there is nothing to wait *in*. When you genuinely need human input (ambiguous acceptance criteria, a decision CLAUDE.md/skills/docs don't resolve and that isn't worth a fork), write `<worktree>/.middle/blocked.json` containing the question and the context a human needs to answer it, then **exit cleanly**. Middle's exit classifier detects the sentinel, parks the workflow on a `waitFor` signal, and surfaces the question on the issue. Do not guess past a real blocker; do not spin idle.

### You may be resumed mid-workstream

When a human answers, middle re-spawns you with the answer injected into your prompt. Your branch, draft PR, `plan.md`, and `decisions.md` are all intact — **continue the workstream from where it is**, don't restart. Re-read the PR's Status section and `plan.md` to orient.

### The plan comment is mechanically gated (reinforces Phase 4)

After your plan step, the dispatcher's **plan-comment guard** verifies a comment by your account containing the plan body exists on the issue. No plan comment → the workflow fails. Phase 4 was always "non-negotiable"; under middle it is literally enforced.

### `gh pr ready` is mechanically gated (reinforces Phase 10)

A `PreToolUse` hook intercepts `gh pr ready`. The dispatcher walks every acceptance criterion in the PR body and requires each to have **either** an evidence link **or** the literal annotation `(deferred: <comment-url>)` where the linked comment is from a non-bot user. Missing evidence → the command is denied with a reason and you must fill the gap or get a deferral. Use the exact `(deferred: <comment-url>)` token — the guard greps for it.

### Status checkboxes trigger verification gates (reinforces Phase 7e)

When you tick a Status checkbox `[ ] → [x]` for phase N and push, the dispatcher runs phase N's verification gates (lint, typecheck, test, project acceptance script). Any failure → it **reverts your checkbox** and posts a comment naming the failed gate. Only tick a phase box when that phase's gates genuinely pass. A reverted checkbox plus a comment is the system talking back — fix the failure and re-tick; don't fight it.

### `.middle/` is middle's operational directory — hands off

Your worktree contains a `.middle/` directory (hooks, session state). Do not read, modify, stage, or commit anything under `.middle/` — it's gitignored and owned by middle. The **one** exception is writing `.middle/blocked.json` to ask a question (above).

### Don't sit idle

Middle's watchdog tracks liveness from hook events on your tool calls. A long stall (default ~15 min with no tool activity) gets your session killed and the workflow marked failed. If you're stuck: make progress, fork to disambiguate, or write `blocked.json` and exit cleanly — never idle.

### Unchanged: you never merge

Middle is not a code reviewer. It stops at "PR ready for review"; a human reviews and merges. The hard rule from the top of this skill stands.
