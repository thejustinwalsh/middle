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

## PR-ready guard: dispatcher does the matching; the shell hook stays dumb
**File(s):** `packages/core/src/hook-script.ts` (`PR_READY_GATE_SH`), `packages/dispatcher/src/gates/pr-ready*.ts`, `packages/dispatcher/src/hook-server.ts`
**Date:** 2026-05-23

**Decision:** A second PreToolUse hook (`pr-ready-gate.sh`, scoped to the Bash tool) forwards the
hook payload to `POST /gates/pr-ready`. The dispatcher does the `gh pr ready` substring match AND
the criteria evaluation; the shell only maps HTTP status → exit code (200/unreachable → exit 0,
4xx/5xx → stderr + exit 2).
**Why:** Keeps the gate's load-bearing logic (command match, criteria walk, deferral/non-bot
check) in unit-testable TypeScript rather than brittle shell. `jq` is not guaranteed present (it
is absent on this host), so parsing `tool_input.command` in-shell was a non-starter; forwarding
the raw payload sidesteps that entirely. Cost is one extra localhost round-trip per Bash
PreToolUse, comparable to the existing per-tool heartbeat.

## PR-ready guard fails OPEN on an unreachable dispatcher
**File(s):** `packages/core/src/hook-script.ts`
**Date:** 2026-05-23

**Decision:** curl code `000` (connection failure) → exit 0 (allow). Only a *reachable* dispatcher
returning 4xx/5xx denies.
**Why:** The heartbeat hook's hard rule is "never block the agent on infra." A gate that wedges
`gh pr ready` because the dispatcher socket hiccuped would be worse than a missed gate — and if
the dispatcher is truly down, the whole dispatch is already broken. A genuine deny always comes
from a live dispatcher, so fail-open costs no real enforcement.

## Epic PR resolved server-side from the session's Epic, not a client-sent PR number
**File(s):** `packages/dispatcher/src/gates/pr-ready-handler.ts`, `packages/dispatcher/src/dispatch.ts`
**Date:** 2026-05-23

**Decision:** The handler resolves the session → workflow row → repo + Epic, then finds the open
Epic PR via `findEpicPr` (matches a closing keyword for the exact Epic number). It does not trust
a PR number from the hook.
**Why:** One Epic = one PR, so the Epic number deterministically identifies the PR and can't be
spoofed by a `gh pr ready <n>` argument pointing elsewhere. This is also what "the gate covers
the whole Epic" requires — the PR body carries the union of every sub-issue's criteria.
