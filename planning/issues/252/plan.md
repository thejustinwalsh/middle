# Issue #252: fix(slots): exclude waiting-human from concurrency slot count; trigger auto-dispatch on park

**Link:** https://github.com/thejustinwalsh/middle/issues/252
**Branch:** fix/slots-waiting-human

## Goal

Ensure a parked (`waiting-human`) epic no longer holds a concurrency slot, and that transitioning to `waiting-human` immediately fires `scheduleAutoDispatch` so the next ready epic takes the freed slot within one poller tick.

## Approach

- Add `'waiting-human'` to the exclusion set in `countActiveImplementationSlots` — a parked epic owns a worktree but no live session, so it must not consume a dispatch slot.
- Add `'waiting-human'` to `SLOT_FREEING_STATES` in `main.ts` so the `broadcastWorkflow` observer triggers `scheduleAutoDispatch` on the transition to `waiting-human`.
- Write a unit test for the slot exclusion (in `workflow-record.test.ts`).
- Write an integration test that drives park → slot-free → next-epic-dispatch with a saturated per-repo cap and asserts dispatch within one auto-dispatch pass (in a new `slots-waiting-human.test.ts`).

## Phases

1. **Unit fix + test** — Add `waiting-human` to `TERMINAL_STATES` / exclusion in `countActiveImplementationSlots`; add unit test asserting the exclusion.
2. **Slot-freeing trigger + integration test** — Add `waiting-human` to `SLOT_FREEING_STATES`; write the integration test that exercises the real park → auto-dispatch path.

## Files likely to change

- `packages/dispatcher/src/workflow-record.ts` — add `'waiting-human'` to the exclusion in `countActiveImplementationSlots`
- `packages/dispatcher/src/main.ts` — add `'waiting-human'` to `SLOT_FREEING_STATES`
- `packages/dispatcher/test/workflow-record.test.ts` — unit test: parked row not counted
- `packages/dispatcher/test/slots-waiting-human.test.ts` — new integration test: park → slot-free → next-epic-dispatch

## Out of scope

- A separate parked-epic cap (`countParkedSlots` / `max_parked`).
- Any change to how a park is entered or to the worktree lifecycle.

## Open questions

- None; the acceptance criteria are clear.
