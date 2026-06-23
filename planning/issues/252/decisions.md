# Decisions — Issue #252

## Where to exclude `waiting-human` from slot counting

**File(s):** `packages/dispatcher/src/workflow-record.ts:603-621`
**Date:** 2026-06-23

**Decision:** Add `'waiting-human'` to a separate `SLOT_EXCLUDED_STATES` constant that is composed with `TERMINAL_STATES` in the `countActiveImplementationSlots` WHERE clause, rather than adding it to `TERMINAL_STATES` itself.

**Why:** `TERMINAL_STATES` has precise semantics beyond slot-counting: it is the hook-correlation guard — a workflow in a terminal state "no longer owns its session." `waiting-human` is NOT terminal; the execution is parked and will resume. Merging it into `TERMINAL_STATES` would be a semantic lie that breaks `findActiveWorkflowBySession` (which uses the same set to find the live owner of a session). The correct abstraction is a separate constant for the slot-counting exclusion, which is combined with `TERMINAL_STATES` only in the `countActiveImplementationSlots` query.

**Evidence:** The docstring at line 370-381 documents the hook-correlation semantics of `TERMINAL_STATES` explicitly. `findActiveWorkflowBySession` at line 391 reads `state NOT IN (TERMINAL_STATES)` — a parked `waiting-human` workflow *should* still appear as the active owner of its session if the session ever resumes (it's not a corpse).

## Where to trigger auto-dispatch on park

**File(s):** `packages/dispatcher/src/main.ts:110`
**Date:** 2026-06-23

**Decision:** Add `'waiting-human'` to `SLOT_FREEING_STATES` in `main.ts`.

**Why:** `SLOT_FREEING_STATES` is a Set of states whose transition triggers `scheduleAutoDispatch`. The transition to `waiting-human` is emitted by the workflow observer (Source 2, line 228) which calls `broadcastWorkflow`, which checks `SLOT_FREEING_STATES.has(state)`. Adding `waiting-human` here is the minimal, correct hook point — it fires `scheduleAutoDispatch` immediately on the park transition, and no other code changes are needed.
