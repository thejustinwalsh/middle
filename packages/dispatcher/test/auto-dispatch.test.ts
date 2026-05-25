import { describe, expect, test } from "bun:test";
import type { ParsedState, ReadyRow } from "@middle/state-issue";
import { autoDispatch, type AutoDispatchDeps } from "../src/auto-dispatch.ts";
import type { SlotState } from "../src/slots.ts";

// The auto-dispatch loop (#50): walk `readyToDispatch`, skip rate-limited
// adapters and exhausted per-adapter slots, stop on a full repo/global, and
// decrement a local slot view as it enqueues. Disabled repos do nothing. The
// deps are injected so the loop is exercised without the engine or `gh`.

function readyRow(rank: number, epicNumber: number, adapter: string): ReadyRow {
  return {
    rank,
    epic: `#${epicNumber} some title`,
    adapter,
    subIssues: 2,
    reason: "criteria clear",
  };
}

function stateWith(rows: ReadyRow[]): ParsedState {
  return {
    version: 1,
    generated: "2026-05-24T00:00:00.000Z",
    runId: "abcd1234",
    intervalMinutes: 15,
    readyToDispatch: rows,
    needsHumanInput: [],
    blocked: [],
    inFlight: [],
    excluded: [],
    rateLimits: { claude: "AVAILABLE", codex: "AVAILABLE", github: "UNKNOWN" },
    slotUsage: {
      adapters: [
        { adapter: "claude", used: 0, max: 2 },
        { adapter: "codex", used: 0, max: 1 },
      ],
      total: { used: 0, max: 3 },
      global: { used: 0, max: 4 },
    },
  };
}

function slots(opts: {
  claude?: { used: number; max: number };
  codex?: { used: number; max: number };
  repo: { used: number; max: number };
  global: { used: number; max: number };
}): SlotState {
  const dim = (d: { used: number; max: number }) => ({
    ...d,
    available: Math.max(0, d.max - d.used),
  });
  const byAdapter: SlotState["byAdapter"] = {};
  if (opts.claude) byAdapter.claude = dim(opts.claude);
  if (opts.codex) byAdapter.codex = dim(opts.codex);
  return { byAdapter, repo: dim(opts.repo), global: dim(opts.global) };
}

type EnqueueCall = { repo: string; epicNumber: number; adapter: string };

function makeDeps(overrides: Partial<AutoDispatchDeps> & { _enqueued?: EnqueueCall[] } = {}): {
  deps: AutoDispatchDeps;
  enqueued: EnqueueCall[];
} {
  const enqueued: EnqueueCall[] = overrides._enqueued ?? [];
  const deps: AutoDispatchDeps = {
    repo: "o/r",
    isAutoDispatchEnabled: () => true,
    readState: async () => stateWith([readyRow(1, 101, "claude"), readyRow(2, 102, "codex")]),
    rateLimitedAdapters: () => new Set<string>(),
    getSlotState: () =>
      slots({
        claude: { used: 0, max: 2 },
        codex: { used: 0, max: 1 },
        repo: { used: 0, max: 3 },
        global: { used: 0, max: 4 },
      }),
    enqueue: async (input) => {
      enqueued.push(input);
      return `wf-${input.epicNumber}`;
    },
    ...overrides,
  };
  return { deps, enqueued };
}

describe("autoDispatch", () => {
  test("normal pass: enqueues every ready row that has a free slot", async () => {
    const { deps, enqueued } = makeDeps();
    const result = await autoDispatch(deps);
    expect(enqueued).toEqual([
      { repo: "o/r", epicNumber: 101, adapter: "claude" },
      { repo: "o/r", epicNumber: 102, adapter: "codex" },
    ]);
    expect(result.enqueued).toEqual([
      { epicNumber: 101, adapter: "claude" },
      { epicNumber: 102, adapter: "codex" },
    ]);
    expect(result.reason).toBe("drained");
  });

  test("does nothing for a repo whose auto-dispatch is disabled", async () => {
    const { deps, enqueued } = makeDeps({ isAutoDispatchEnabled: () => false });
    const result = await autoDispatch(deps);
    expect(enqueued).toEqual([]);
    expect(result.reason).toBe("disabled");
  });

  test("skips a rate-limited adapter but keeps dispatching others", async () => {
    const { deps, enqueued } = makeDeps({
      rateLimitedAdapters: () => new Set(["claude"]),
    });
    const result = await autoDispatch(deps);
    // #101 (claude) skipped; #102 (codex) still dispatched.
    expect(enqueued).toEqual([{ repo: "o/r", epicNumber: 102, adapter: "codex" }]);
    expect(result.reason).toBe("drained");
  });

  test("skips a row whose per-adapter slot is exhausted, continues to the next adapter", async () => {
    const { deps, enqueued } = makeDeps({
      getSlotState: () =>
        slots({
          claude: { used: 2, max: 2 }, // claude full
          codex: { used: 0, max: 1 },
          repo: { used: 2, max: 3 },
          global: { used: 2, max: 4 },
        }),
    });
    const result = await autoDispatch(deps);
    expect(enqueued).toEqual([{ repo: "o/r", epicNumber: 102, adapter: "codex" }]);
    expect(result.reason).toBe("drained");
  });

  test("stops entirely when the repo total is exhausted (slots-exhausted)", async () => {
    const { deps, enqueued } = makeDeps({
      getSlotState: () =>
        slots({
          claude: { used: 0, max: 2 },
          codex: { used: 0, max: 1 },
          repo: { used: 3, max: 3 }, // repo full → break before any enqueue
          global: { used: 3, max: 4 },
        }),
    });
    const result = await autoDispatch(deps);
    expect(enqueued).toEqual([]);
    expect(result.reason).toBe("slots-exhausted");
  });

  test("stops when the global total is exhausted even if the repo has room", async () => {
    const { deps, enqueued } = makeDeps({
      getSlotState: () =>
        slots({
          claude: { used: 0, max: 2 },
          codex: { used: 0, max: 1 },
          repo: { used: 1, max: 3 },
          global: { used: 4, max: 4 }, // global full
        }),
    });
    const result = await autoDispatch(deps);
    expect(enqueued).toEqual([]);
    expect(result.reason).toBe("slots-exhausted");
  });

  test("decrements local counters as it enqueues so a shared cap stops mid-pass", async () => {
    // Two claude rows but repo cap leaves room for only one: the first reserves
    // the last slot, the second sees repo exhausted and the loop stops.
    const { deps, enqueued } = makeDeps({
      readState: async () => stateWith([readyRow(1, 201, "claude"), readyRow(2, 202, "claude")]),
      getSlotState: () =>
        slots({
          claude: { used: 0, max: 5 },
          repo: { used: 2, max: 3 }, // only 1 repo slot left
          global: { used: 2, max: 8 },
        }),
    });
    const result = await autoDispatch(deps);
    expect(enqueued).toEqual([{ repo: "o/r", epicNumber: 201, adapter: "claude" }]);
    expect(result.reason).toBe("slots-exhausted");
  });

  test("a refused enqueue (collision/null) does not consume a local slot", async () => {
    // The first row collides (enqueue → null): it must not decrement the local
    // view, so the second row still sees the slot it would otherwise have lost.
    let first = true;
    const { deps, enqueued } = makeDeps({
      readState: async () => stateWith([readyRow(1, 301, "claude"), readyRow(2, 302, "claude")]),
      getSlotState: () =>
        slots({
          claude: { used: 0, max: 5 },
          repo: { used: 2, max: 3 }, // 1 slot; if the collision wrongly consumed it, #302 would be skipped
          global: { used: 2, max: 8 },
        }),
      enqueue: async (input) => {
        if (first) {
          first = false;
          return null; // collision
        }
        enqueued.push(input);
        return `wf-${input.epicNumber}`;
      },
    });
    const result = await autoDispatch(deps);
    expect(enqueued).toEqual([{ repo: "o/r", epicNumber: 302, adapter: "claude" }]);
    // Both rows were walked (the collision was a no-op, the second dispatched),
    // so the loop drained rather than breaking on exhaustion.
    expect(result.reason).toBe("drained");
  });

  test("ignores the empty-state (no ready rows) without enqueuing", async () => {
    const { deps, enqueued } = makeDeps({ readState: async () => stateWith([]) });
    const result = await autoDispatch(deps);
    expect(enqueued).toEqual([]);
    expect(result.reason).toBe("drained");
  });

  test("no pre-dispatch complexity gate: a large-sub-issue Epic still dispatches (#52)", async () => {
    // The loop's only gates are slots + rate limits — never sub-issue count or any
    // complexity estimate. A ready Epic dispatches; a complexity overrun is a
    // runtime pause on a sub-issue, not a pre-dispatch decision the loop makes.
    const big: ReadyRow = {
      rank: 1,
      epic: "#401 huge epic",
      adapter: "claude",
      subIssues: 99,
      reason: "many phases",
    };
    const { deps, enqueued } = makeDeps({ readState: async () => stateWith([big]) });
    const result = await autoDispatch(deps);
    expect(enqueued).toEqual([{ repo: "o/r", epicNumber: 401, adapter: "claude" }]);
    expect(result.reason).toBe("drained");
  });
});
