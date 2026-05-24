# Dogfooding crossover — operator runbook

From Phase 3 onward, middle dispatches its own work. The crossover is the moment
the operator runs `mm init` **on the middle repo itself** and hands the wheel to
middle. The spec calls this out as a deliberate chicken-and-egg step
(build spec → "Dogfooding rules" #5): bootstrap is manual up to here, and the
crossover is performed once, by hand, by the operator — not by an agent that is
itself mid-dispatch.

## Why an in-flight agent must not self-run the crossover

When middle dispatches an agent for an Epic, the agent runs inside a worktree
whose `.middle/` directory holds that dispatch's operational state (the brief,
the hook script, session bookkeeping). The crossover commands conflict with that
in two load-bearing ways:

1. **`mm dispatch . <issue>` nests agents.** It needs the dispatcher process
   (`mm start`, port 8822), creates a *second* worktree, and spawns a *second*
   `claude`/tmux session. Run from inside a live dispatch it collides with the
   running dispatcher and consumes a slot against itself. It also needs a
   **manually created** Epic to target.
2. **`mm init .` creates live GitHub state.** It opens the real
   `agent-queue:state` issue and label on `thejustinwalsh/middle`. Done from an
   unmerged PR branch, that issue is orphaned if the PR is reworked. The state
   issue is meant to be "real from Phase 3" (dogfooding rule #2) — created once,
   deliberately, at the canonical checkout.

So the capability is built and verified (PR #81, sub-issues #22–#25); the live
crossover is the operator's to run. The committable slice of the self-bootstrap —
gitignoring `.middle/` (mm init step 7) — is already in the repo.

## Runbook

Run from a **clean** checkout of `thejustinwalsh/middle` (not a middle worktree):

```bash
# 0. Preconditions — all green.
mm doctor

# 1. Inspect the plan first (no mutation).
mm init . --dry-run

# 2. Perform the crossover. Creates the agent-queue:state label + state issue,
#    stages skills to .claude/skills/ and .codex/skills/, writes .middle/hooks/
#    hook.sh, per-CLI hook config, and .middle/config.toml (with the issue number).
mm init .

# 3. Commit the shared skills (.claude/skills/ and .codex/skills/ are committed;
#    .middle/ is gitignored).
git add .claude/skills .codex/skills .gitignore
git commit -m "chore: install middle skills (dogfooding crossover)"

# 4. Verify the state issue exists and conforms.
gh issue list --repo thejustinwalsh/middle --label agent-queue:state
#    Its body parses against schemas/state-issue.v1.md (validated by mm init).

# 5. Dispatch a manually created Epic against middle. `mm dispatch` is
#    self-contained — it runs its OWN hook server + workflow engine inline — so
#    do NOT run `mm start` first: both bind the dispatcher port (8822) and a
#    running `mm start` makes `mm dispatch` fail with EADDRINUSE. (`mm start` is
#    the long-running daemon for Phase 8 auto-dispatch, not manual dispatch.)
mm dispatch . <epic-number>     # the Epic (see "Creating a dispatchable Epic" below)
                                # runs in the foreground, streaming workflow/hook logs

# To reverse the crossover entirely:
mm uninit .                     # closes the state issue, removes staged files
```

### Creating a dispatchable Epic

`mm dispatch . <epic-number>` expects an **Epic**: a GitHub issue that has
**sub-issues**, where each sub-issue is one phase of the work and carries its own
acceptance criteria. The agent works the open sub-issues down, one per phase, on a
single branch/PR.

Don't hand-author these ad hoc — use the **`creating-github-issues`** skill (in
`.claude/skills/creating-github-issues/`): give it a plan and it files the parent
Epic plus sub-issues with acceptance criteria, the right labels, and the proper
parent/child hierarchy that the recommender and implementer expect. Minimum the
dispatch needs:

- a **parent** issue with one or more **sub-issues** attached (the phases),
- **acceptance criteria** on each sub-issue (an Epic whose children lack them is
  classified `needs-human` and won't be dispatched),
- optionally a `phase:N` / `dogfood` label for grouping (not required to dispatch).

`mm init` is idempotent: a re-run with a matching `bootstrap.version` refreshes
skills/hooks but keeps the config and the existing state issue.
