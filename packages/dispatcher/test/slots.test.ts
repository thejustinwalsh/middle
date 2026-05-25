import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openAndMigrate } from "../src/db.ts";
import { getSlotState, hasFreeSlot, reserveSlot, type SlotLimits } from "../src/slots.ts";
import { createWorkflowRecord, updateWorkflow } from "../src/workflow-record.ts";

// Slot accounting (#49): the three dimensions (per-adapter, per-repo, global)
// derived from live `workflows` rows + merged config, and the guard the enqueue
// paths consult. The recommender's dedicated row must never count against the
// dispatch slots.

let db: Database;

const LIMITS: SlotLimits = {
  perAdapter: { claude: 2, codex: 1 },
  repoMax: 3,
  globalMax: 4,
};

/** Insert a non-terminal (pending → running) workflow row of the given kind. */
function addWorkflow(
  id: string,
  kind: "implementation" | "recommender",
  repo: string,
  adapter: string,
): void {
  createWorkflowRecord(db, {
    id,
    kind,
    repo,
    epicNumber: kind === "recommender" ? null : 1,
    adapter,
  });
  updateWorkflow(db, id, { state: "running" });
}

beforeEach(() => {
  db = openAndMigrate(":memory:");
});

afterEach(() => {
  db.close();
});

describe("getSlotState", () => {
  test("free-slot: no active work reports full availability across every dimension", () => {
    const state = getSlotState(db, "o/r", LIMITS);
    expect(state.byAdapter.claude).toEqual({ used: 0, max: 2, available: 2 });
    expect(state.byAdapter.codex).toEqual({ used: 0, max: 1, available: 1 });
    expect(state.repo).toEqual({ used: 0, max: 3, available: 3 });
    expect(state.global).toEqual({ used: 0, max: 4, available: 4 });
    expect(hasFreeSlot(state, "claude")).toBe(true);
    expect(hasFreeSlot(state, "codex")).toBe(true);
  });

  test("at-capacity: a full repo reports zero availability and the guard refuses", () => {
    addWorkflow("w1", "implementation", "o/r", "claude");
    addWorkflow("w2", "implementation", "o/r", "codex");
    addWorkflow("w3", "implementation", "o/r", "claude"); // repoMax = 3 → repo now full
    const state = getSlotState(db, "o/r", LIMITS);
    expect(state.repo).toEqual({ used: 3, max: 3, available: 0 });
    // Even though codex's per-adapter cap (1) isn't yet hit by codex alone (1 used),
    // the repo dimension is full, so nothing can enqueue.
    expect(hasFreeSlot(state, "claude")).toBe(false);
    expect(hasFreeSlot(state, "codex")).toBe(false);
  });

  test("per-adapter cap binds before the repo cap", () => {
    addWorkflow("w1", "implementation", "o/r", "claude");
    addWorkflow("w2", "implementation", "o/r", "claude"); // claude cap = 2 → adapter full
    const state = getSlotState(db, "o/r", LIMITS);
    expect(state.byAdapter.claude).toEqual({ used: 2, max: 2, available: 0 });
    expect(state.repo).toEqual({ used: 2, max: 3, available: 1 }); // repo still has room
    // claude is capped out; codex still has a repo slot and its own slot free.
    expect(hasFreeSlot(state, "claude")).toBe(false);
    expect(hasFreeSlot(state, "codex")).toBe(true);
  });

  test("global cap binds across repos even when this repo has room", () => {
    // Fill the global cap (4) with work spread across two repos; this repo (o/r)
    // holds 2 of them, so its repo dimension (max 3) still shows room — but the
    // global dimension is exhausted, so the guard refuses.
    addWorkflow("a1", "implementation", "o/r", "claude");
    addWorkflow("a2", "implementation", "o/r", "codex");
    addWorkflow("b1", "implementation", "other/repo", "claude");
    addWorkflow("b2", "implementation", "other/repo", "codex");
    const state = getSlotState(db, "o/r", LIMITS);
    expect(state.repo.used).toBe(2);
    expect(state.repo.available).toBe(1);
    expect(state.global).toEqual({ used: 4, max: 4, available: 0 });
    expect(hasFreeSlot(state, "claude")).toBe(false);
  });

  test("the recommender's own row is never counted against dispatch slots", () => {
    addWorkflow("rec", "recommender", "o/r", "claude");
    const state = getSlotState(db, "o/r", LIMITS);
    expect(state.repo.used).toBe(0);
    expect(state.global.used).toBe(0);
    expect(state.byAdapter.claude!.used).toBe(0);
    expect(hasFreeSlot(state, "claude")).toBe(true);
  });

  test("used over max clamps available to 0 (a tightened cap never goes negative)", () => {
    addWorkflow("w1", "implementation", "o/r", "claude");
    addWorkflow("w2", "implementation", "o/r", "claude");
    addWorkflow("w3", "implementation", "o/r", "claude"); // 3 claude vs cap 2
    const state = getSlotState(db, "o/r", { perAdapter: { claude: 2 }, repoMax: 2, globalMax: 2 });
    expect(state.byAdapter.claude!.available).toBe(0);
    expect(state.repo.available).toBe(0);
    expect(state.global.available).toBe(0);
  });

  test("an adapter with no per-adapter cap is gated only by the repo and global dims", () => {
    // codex has no entry in perAdapter here → no separate adapter ceiling.
    const limits: SlotLimits = { perAdapter: { claude: 2 }, repoMax: 3, globalMax: 4 };
    const state = getSlotState(db, "o/r", limits);
    expect(state.byAdapter.codex).toBeUndefined();
    expect(hasFreeSlot(state, "codex")).toBe(true); // repo + global have room
  });
});

describe("reserveSlot", () => {
  test("decrements the adapter, repo, and global dimensions for the loop's local view", () => {
    const state = getSlotState(db, "o/r", LIMITS);
    const after = reserveSlot(state, "claude");
    expect(after.byAdapter.claude).toEqual({ used: 1, max: 2, available: 1 });
    expect(after.repo).toEqual({ used: 1, max: 3, available: 2 });
    expect(after.global).toEqual({ used: 1, max: 4, available: 3 });
    // The original is left untouched (pure).
    expect(state.repo.available).toBe(3);
  });

  test("reserving down to capacity flips the guard to refuse", () => {
    let state = getSlotState(db, "o/r", LIMITS);
    state = reserveSlot(state, "codex"); // codex cap = 1 → now full
    expect(hasFreeSlot(state, "codex")).toBe(false);
    expect(hasFreeSlot(state, "claude")).toBe(true);
  });

  test("reserving an adapter with no cap still decrements repo + global", () => {
    const limits: SlotLimits = { perAdapter: { claude: 2 }, repoMax: 3, globalMax: 4 };
    let state = getSlotState(db, "o/r", limits);
    state = reserveSlot(state, "codex");
    expect(state.repo.used).toBe(1);
    expect(state.global.used).toBe(1);
    expect(state.byAdapter.codex).toBeUndefined();
  });
});
