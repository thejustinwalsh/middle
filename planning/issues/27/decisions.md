# Decisions — Epic #27 (Skill enforcement gates)

Running log of non-trivial decisions. Distilled into PR review comments at finalize time.

## Plan-comment guard: substring match, optional author filter
**File(s):** `packages/dispatcher/src/gates/plan-comment.ts`
**Date:** 2026-05-23

**Decision:** The guard normalizes (CRLF→LF, edge-trim) and does a substring match of the
plan body against each Epic comment, optionally filtered to the agent's gh login. An
empty/whitespace plan body never matches.
**Why:** The plan is posted verbatim via `gh issue comment --body-file`, so the only expected
differences are line-endings and edge whitespace. Substring (not equality) absorbs a preamble
the agent may add above the plan. The author filter encodes "by the agent's account" without
making it mandatory (callers that can't resolve a login still get containment enforcement).
The empty-plan guard prevents a missing/empty plan.md from vacuously passing (every body
"contains" the empty string).

## Plan-comment guard wired at the completion boundary
**File(s):** `packages/dispatcher/src/workflows/implementation.ts:280`
**Date:** 2026-05-23

**Decision:** The guard runs in `cleanup`, before `destroyWorktree`, and only when the drive
outcome is `completed`. A guard failure flips the final state to `failed`. It is opt-in via the
`planCommentReader` dep.
**Why:** The minimal Phase-1 workflow has no separate `plan`/`implement-loop` steps to gate
between (those land with the fuller workflow). The realistic enforcement point today is the
completion boundary: an agent that reached "done" without ever posting its plan is caught and
the dispatch fails with the exact reason. The plan body must be read while the worktree is
still alive, hence "before destroyWorktree". Opt-in keeps the gate-free unit tests unguarded.
