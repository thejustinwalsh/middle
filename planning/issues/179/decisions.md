# Decisions — issue #179

## Reuse the branch via a ref-exists check, not `git worktree add --force` or a try/`-b`-then-retry
**File(s):** `packages/dispatcher/src/worktree.ts:139`
**Date:** 2026-05-29

**Decision:** Probe `git rev-parse --verify refs/heads/<branch>` and choose `git worktree add <path> <branch>` (reuse) vs `… -b <branch>` (create) up front.
**Why:** This is the issue's proposed fix and the most honest expression of intent ("give me a worktree for this branch; create it if absent"). Alternatives rejected:
- `--force` would let two worktrees check out the same branch — exactly the corruption the plain form refuses; wrong tool.
- try `-b`, catch "already exists", retry without — relies on parsing git's error string (locale/version-fragile) and does two spawns on the hot path.
A single `rev-parse --verify` is cheap, deterministic, and locale-independent.
**Evidence:** `destroyWorktree` already uses the same `rev-parse --verify refs/heads/<branch>` idiom (worktree.ts:174) to gate its branch delete — this mirrors an established in-file pattern.

## Out of scope: branch checked out in another worktree
**File(s):** `packages/dispatcher/src/worktree.ts`
**Date:** 2026-05-29

**Decision:** Don't special-case `fatal: '<b>' is already used by worktree at …`. Let it surface as `WorktreeError`.
**Why:** The 409 active-workflow guard (`hasNonTerminalEpicWorkflow`) prevents two concurrent dispatches of the same Epic, so a legitimate dispatch never finds its branch checked out in a live worktree. A *stale* registration is the reconciler's domain (`pruneWorktreeAt` deregisters). Auto-`--force`-ing here would mask a real "two things own this branch" bug.

## Flip the orphan row to `failed` rather than create it lazily
**File(s):** `packages/dispatcher/src/workflows/implementation.ts:710`
**Date:** 2026-05-29

**Decision:** Keep `createWorkflowRecord` first in `prepareWorktree`; wrap the `createWorktree` call so a throw flips the row `→ failed` before rethrowing.
**Why:** bunqueue's saga only compensates *completed* steps (`compensator.ts` filters `status === 'completed'`), so a throw inside `prepareWorktree` never runs `cleanupWorktree` and never sets a terminal state — the middle row stays `pending`. A `pending` row is non-terminal, so `hasNonTerminalEpicWorkflow` 409-blocks every later dispatch.
The obvious alternative — create the record only *after* `createWorktree` succeeds — fixes the DB guard but **leaks the in-memory `inFlightEpics` reservation**: `broadcastWorkflow` only releases the reservation when it finds a row (`main.ts:157`), so with no row the reservation is never freed and blocks re-dispatch just as hard. Flipping the existing row to `failed` clears *both* guards: the row is terminal (DB 409 passes) and the `failed` broadcast finds the row and frees the reservation.
**Evidence:** `failed` ∈ `TERMINAL_STATES` (`workflow-record.ts:202`) and ∈ `SLOT_FREEING_STATES` (`main.ts:82`); bunqueue's executor already emits `workflow:failed` when a step throws (`executor.js` catch block), so the `failed` state is broadcast regardless — we just make the persistent row agree.

## The promotion is guarded to `kind = 'implementation'`, not every `workflow:failed`
**File(s):** `packages/dispatcher/src/workflow-record.ts` (`promotePendingToFailed`)
**Date:** 2026-05-29

**Decision:** `promotePendingToFailed` scopes its `UPDATE` to `kind = 'implementation' AND state = 'pending'`. The daemon's `onAny` calls it on every `workflow:failed`, but the SQL only touches implementation rows.
**Why:** The recommender and documentation workflows share the daemon engine (so the same `onAny` handler), and — unlike implementation — they legitimately sit at `pending` *past* their first step: `check-rate-limit → prepare-*-worktree → build-prompt` write no running state, and the first `launching` write is the agent-spawn step. A terminal `build-prompt` failure there runs compensation over the *completed* `prepare-*-worktree` step → `compensated`. bunqueue emits `workflow:failed` synchronously *before* compensation, so an unguarded flip would transiently set `failed`, emit a spurious `failed` SSE frame, and fire a premature slot-freeing auto-dispatch. The implementation chain has no such window (its launch step writes `launching` as its first action, immediately after `prepare-worktree`), and `hasNonTerminalEpicWorkflow` — the 409 guard this fix exists to unblock — is itself implementation-scoped. So implementation is both the only kind that needs the flip and the only kind where it's race-free.
**Evidence:** Surfaced by an adversarial self-review pass (the internal "be your own CodeRabbit" loop). Verified against `recommender.ts:357–453` and `documentation.ts` step chains and `implementation.ts:771` (`launching` written first thing in `driveOnce`).
