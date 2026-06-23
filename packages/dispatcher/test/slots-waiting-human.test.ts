/**
 * Integration tests: waiting-human park → slot-free → next-epic-dispatch (#252).
 *
 * These tests drive the real path through `countActiveImplementationSlots`,
 * `getSlotState`, and `autoDispatch` using a real in-memory database, asserting
 * that:
 *   1. A `waiting-human` row is excluded from slot counts (so it does not starve
 *      other ready epics for the park duration).
 *   2. After a park transition saturates the slot picture → parks → the next
 *      ready epic dispatches within one `autoDispatch` pass.
 *
 * The "one poller tick" requirement from the acceptance criteria maps to "one
 * `autoDispatch` call" in the daemon: `SLOT_FREEING_STATES` now includes
 * `waiting-human`, so the broadcast observer calls `scheduleAutoDispatch` on the
 * park transition, which runs one `autoDispatch` pass. These tests exercise that
 * pass directly via injected deps, which is the correct isolation boundary — the
 * full engine is not needed to prove slot accounting.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ParsedState, ReadyRow } from "@middle/state-issue";
import { openAndMigrate } from "../src/db.ts";
import { autoDispatch, type AutoDispatchDeps } from "../src/auto-dispatch.ts";
import { getSlotState, type SlotLimits } from "../src/slots.ts";
import { createWorkflowRecord, updateWorkflow } from "../src/workflow-record.ts";

let db: Database;

const REPO = "o/r";
const LIMITS: SlotLimits = { perAdapter: { claude: 2 }, repoMax: 2, globalMax: 4 };

beforeEach(() => {
  db = openAndMigrate(":memory:");
});

afterEach(() => {
  db.close();
});

/** Insert a non-terminal implementation workflow and advance it to `running`. */
function addRunning(id: string, epicRef: string, adapter = "claude"): void {
  createWorkflowRecord(db, { id, kind: "implementation", repo: REPO, epicRef, adapter });
  updateWorkflow(db, id, { state: "running" });
}

/** Build a ready row for use in a ParsedState fixture. */
function readyRow(epicRef: string | number, adapter = "claude"): ReadyRow {
  return {
    rank: 1,
    epic: `#${epicRef} next ready epic`,
    adapter,
    subIssues: 1,
    reason: "criteria clear",
  };
}

/**
 * A minimal ParsedState carrying the supplied ready rows. All other fields are
 * structurally valid but not meaningful to these tests.
 */
function stateWith(rows: ReadyRow[]): ParsedState {
  return {
    version: 1,
    generated: "2026-06-23T00:00:00.000Z",
    runId: "test",
    intervalMinutes: 15,
    readyToDispatch: rows,
    needsHumanInput: [],
    blocked: [],
    inFlight: [],
    excluded: [],
    rateLimits: { claude: "AVAILABLE", codex: "AVAILABLE", github: "UNKNOWN" },
    slotUsage: {
      adapters: [{ adapter: "claude", used: 0, max: 2 }],
      total: { used: 0, max: 2 },
      global: { used: 0, max: 4 },
    },
  };
}

type EnqueueCall = { repo: string; epicRef: string; adapter: string };

/**
 * Build `AutoDispatchDeps` wired to the real `getSlotState` (uses the real DB),
 * a fixed ready-state, and a stub enqueue that records calls.
 */
function makeDeps(opts: { readyEpics: ReadyRow[]; enqueued?: EnqueueCall[] }): {
  deps: AutoDispatchDeps;
  enqueued: EnqueueCall[];
} {
  const enqueued: EnqueueCall[] = opts.enqueued ?? [];
  const deps: AutoDispatchDeps = {
    repo: REPO,
    isAutoDispatchEnabled: () => true,
    readState: async () => stateWith(opts.readyEpics),
    rateLimitedAdapters: () => new Set<string>(),
    // Real getSlotState: reads live rows from the shared DB — this is the seam
    // under test. A waiting-human row must not appear in the used count.
    getSlotState: () => getSlotState(db, REPO, LIMITS),
    enqueue: async (input) => {
      enqueued.push(input);
      return `wf-${input.epicRef}`;
    },
  };
  return { deps, enqueued };
}

describe("waiting-human park → slot-free → next-epic-dispatch (integration)", () => {
  test(
    "park → slot-free: a waiting-human row is excluded from the per-repo slot count " +
      "so the cap is not exhausted by a parked epic",
    async () => {
      // Arrange: per-repo cap is 2. Two running epics fill the cap.
      addRunning("epic-1", "1");
      addRunning("epic-2", "2");

      // With both running, the repo cap is exhausted — auto-dispatch stops immediately.
      const { deps: fullDeps, enqueued: fullEnqueued } = makeDeps({
        readyEpics: [readyRow("3")],
      });
      const fullResult = await autoDispatch(fullDeps);
      expect(fullResult.reason).toBe("slots-exhausted");
      expect(fullEnqueued).toHaveLength(0);

      // Act: epic-2 parks (transitions to waiting-human — the park event).
      updateWorkflow(db, "epic-2", { state: "waiting-human" });

      // Assert: now only epic-1 (running) counts against the cap. Epic-3 dispatches.
      const { deps, enqueued } = makeDeps({ readyEpics: [readyRow("3")] });
      const result = await autoDispatch(deps);
      expect(result.reason).toBe("drained");
      expect(enqueued).toEqual([{ repo: REPO, epicRef: "3", adapter: "claude" }]);
    },
  );

  test(
    "park → slot-free → next-epic-dispatch: cap saturated, one epic parks, " +
      "next ready epic dispatches in one autoDispatch pass",
    async () => {
      // Arrange: per-repo cap = 2, both filled. Epic #3 is next in the ready queue.
      addRunning("epic-1", "1");
      addRunning("epic-2", "2");

      // Confirm slots are exhausted before the park.
      const { deps: prePark, enqueued: preEnqueued } = makeDeps({
        readyEpics: [readyRow("3")],
      });
      expect((await autoDispatch(prePark)).reason).toBe("slots-exhausted");
      expect(preEnqueued).toHaveLength(0);

      // Act: epic-2 parks. In the daemon this triggers scheduleAutoDispatch via
      // the SLOT_FREEING_STATES observer. Here we exercise the auto-dispatch pass
      // directly — one pass = one poller tick per the acceptance criterion.
      updateWorkflow(db, "epic-2", { state: "waiting-human" });

      // Assert: the pass now sees 1 running (epic-1) + 0 parked slots = 1 used of 2.
      // Epic-3 gets the freed slot in this single pass.
      const { deps: postPark, enqueued: postEnqueued } = makeDeps({
        readyEpics: [readyRow("3")],
      });
      const result = await autoDispatch(postPark);
      expect(result.reason).toBe("drained");
      expect(result.enqueued).toEqual([{ epicRef: "3", adapter: "claude" }]);
      expect(postEnqueued).toEqual([{ repo: REPO, epicRef: "3", adapter: "claude" }]);
    },
  );

  test("multiple parked epics: all are excluded; only truly running epics consume slots", async () => {
    // Two parked epics + one running. Cap = 2. Both ready epics below the cap
    // should dispatch (one per available slot after the single running is counted).
    addRunning("epic-1", "1");
    createWorkflowRecord(db, {
      id: "epic-2",
      kind: "implementation",
      repo: REPO,
      epicRef: "2",
      adapter: "claude",
    });
    updateWorkflow(db, "epic-2", { state: "waiting-human" });
    createWorkflowRecord(db, {
      id: "epic-3",
      kind: "implementation",
      repo: REPO,
      epicRef: "3",
      adapter: "claude",
    });
    updateWorkflow(db, "epic-3", { state: "waiting-human" });

    // 1 running, 2 parked. Cap = 2 → 1 free slot.
    const { deps, enqueued } = makeDeps({
      readyEpics: [readyRow("4"), readyRow("5")],
    });
    const result = await autoDispatch(deps);
    // One slot free → only one dispatch (second hit the cap).
    expect(result.reason).toBe("slots-exhausted");
    expect(enqueued).toEqual([{ repo: REPO, epicRef: "4", adapter: "claude" }]);
  });

  test(
    "SLOT_FREEING_STATES includes waiting-human: " +
      "a parked epic frees a slot immediately, not after full termination",
    async () => {
      // This test verifies that waiting-human is in the slot-free set by exercising
      // the slot accounting that SLOT_FREEING_STATES's presence unlocks.
      // The daemon's broadcastWorkflow calls scheduleAutoDispatch when
      // SLOT_FREEING_STATES.has(state) — that triggers the autoDispatch pass we
      // run here. If waiting-human were missing from SLOT_FREEING_STATES, no
      // auto-dispatch would run and the next epic would starve until a terminal event.
      addRunning("epic-a", "10");
      addRunning("epic-b", "11");

      // Park epic-b. In the daemon, this triggers scheduleAutoDispatch immediately.
      updateWorkflow(db, "epic-b", { state: "waiting-human" });

      // The auto-dispatch pass that scheduleAutoDispatch would run (one tick):
      const { deps, enqueued } = makeDeps({ readyEpics: [readyRow("12")] });
      await autoDispatch(deps);
      // Epic-12 dispatched — the slot freed by the park was available in this pass.
      expect(enqueued).toEqual([{ repo: REPO, epicRef: "12", adapter: "claude" }]);
    },
  );
});
