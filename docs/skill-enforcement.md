# Skill enforcement

A dispatched agent runs a skill (`implementing-github-issues`) that describes the workflow — open a draft PR, work the phases, verify each, mark ready. The skill is instructions, and instructions can be skipped. middle's job is to make the load-bearing steps **mechanical**: gates that pass or fail on evidence, not on the agent's say-so. This document explains how those gates work and why they exist.

The principle: the skill says what good work looks like; the gates check that it happened. An agent that forgets to post its plan, ticks a phase whose tests fail, or marks a PR ready with unmet acceptance criteria is corrected by the system, not by a human noticing later.

## Hooks are the observation channel

`mm init` installs a hook script that POSTs every agent event to the dispatcher. Two of those events carry the workflow:

- **`SessionStart`** establishes the session — its payload yields the transcript path the dispatcher reads for the rest of the run.
- **`Stop`** is a turn boundary. At each Stop the dispatcher classifies what the agent did (`classifyStop` in [adapters.md](adapters.md#stop-classification)): it finished, it asked a question, it hit a rate limit, or it stopped without a clear outcome.

The hooks are the fast path; the on-disk transcript is the source of truth. The watchdog cron reconciles the two so a dropped hook does not strand a workflow (see [architecture.md](architecture.md#the-crons)).

## The plan-comment guard

The skill requires the agent to post its plan as a comment on the Epic before writing code. The guard (`packages/dispatcher/src/gates/plan-comment.ts`) verifies a plan comment by the agent's account exists on the issue. No plan comment, no progress — the public commitment the skill calls "non-negotiable" is enforced rather than trusted.

## The PR-ready gate

The strongest gate intercepts `gh pr ready`. A `PreToolUse` hook matches the command and calls the dispatcher's `/gates/pr-ready` endpoint before the tool runs (`packages/dispatcher/src/gates/pr-ready.ts`).

The dispatcher walks the Epic PR's acceptance criteria — the union of every sub-issue's criteria, all rendered into the one PR body — and requires each to carry **either**:

- an evidence link (a URL or `#`-reference proving delivery), **or**
- a `(deferred: <comment-url>)` annotation whose linked comment is by a non-bot user.

An empty criteria section denies, so the gate can't be bypassed by deleting it. A 200 response lets the tool run; a 403 with a reason blocks it and prints why. This is what stops an agent from marking a PR ready with work still undone or with scope unilaterally cut.

## Phase-verification gates

When the agent ticks a sub-issue's Status checkbox `[ ] → [x]` and pushes, the dispatcher runs that sub-issue's verification gates — the lint, typecheck, test, and acceptance commands declared in the repo's `verify.toml` (`packages/dispatcher/src/gates/verify.ts`). It posts an evidence comment for the phase. If a gate fails, the dispatcher reverts the checkbox and comments naming the failed gate (`checkbox-revert.ts`). A phase is "done" only when its gates actually pass.

## Parking instead of guessing

When the agent hits a question it can't resolve — ambiguous acceptance criteria, or a decision needing more candidate forks than the configured complexity ceiling — the skill writes `.middle/blocked.json` and exits rather than guessing. `classifyStop` detects the sentinel and classifies the Stop as `asked-question`; the dispatcher arms a `waitFor` signal, parks the workflow as `waiting-human`, and surfaces the question on the Epic.

The poller watches for the unblocking event — a human reply on the issue, or a PR review verdict — and fires the resume signal, which re-enters the parked workflow where it left off. A complexity pause (`kind: "complexity"` in the sentinel) is surfaced distinctly so a human can reduce scope or approve a best-judgment call.

This is the design's bright line: an agent that is stuck parks and escalates; it never guesses past a real blocker, and it never sits idle (the watchdog kills a stalled session).

## What middle never does

middle stops at "PR ready for review." The final review and the merge are the human's gate — no gate, hook, or cron merges a PR. Enforcement holds the agent to the workflow; it does not sign off on the work.
