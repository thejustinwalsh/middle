import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAndMigrate } from "../src/db.ts";
import { type EpicPrLifecycle, reconcileMergedParks } from "../src/poller.ts";
import {
  createWorkflowRecord,
  finalizeParkedWorkflow,
  getWorkflow,
  updateWorkflow,
} from "../src/workflow-record.ts";

let scratch: string;
let db: Database;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "middle-reconcile-"));
  db = openAndMigrate(join(scratch, "db.sqlite3"));
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const REPO = "thejustinwalsh/middle";

/** Seed a parked (`waiting-human`) implementation workflow for `epic`, with a worktree. */
function seedParked(epic: number, worktreePath: string = `/wt/issue-${epic}`): string {
  const id = crypto.randomUUID();
  createWorkflowRecord(db, {
    id,
    kind: "implementation",
    repo: REPO,
    epicNumber: epic,
    adapter: "claude",
  });
  updateWorkflow(db, id, { state: "waiting-human", worktreePath });
  return id;
}

/** A reconcile-deps stub: lifecycle keyed by epic, a budget, and a worktree-removal spy. */
function makeDeps(
  lifecycleByEpic: Record<number, EpicPrLifecycle | null>,
  opts: { remaining?: number } = {},
) {
  const removed: Array<{ repo: string; worktreePath: string | null }> = [];
  const deps = {
    db,
    github: {
      async findEpicPrLifecycle(_repo: string, epic: number) {
        return lifecycleByEpic[epic] ?? null;
      },
      async getRateLimit() {
        return { remaining: opts.remaining ?? 5000, resetAt: 0 };
      },
    },
    removeWorktree: async (repo: string, worktreePath: string | null) => {
      removed.push({ repo, worktreePath });
    },
  };
  return { deps, removed };
}

describe("reconcileMergedParks", () => {
  test("a merged PR finalizes the parked workflow to `completed` and tears down its worktree", async () => {
    const id = seedParked(50);
    const { deps, removed } = makeDeps({ 50: { number: 91, state: "MERGED" } });

    expect(await reconcileMergedParks(deps)).toBe(1);
    expect(getWorkflow(db, id)?.state).toBe("completed");
    expect(removed).toEqual([{ repo: REPO, worktreePath: "/wt/issue-50" }]);
  });

  test("a closed-unmerged PR finalizes to `cancelled`", async () => {
    const id = seedParked(51);
    const { deps } = makeDeps({ 51: { number: 92, state: "CLOSED" } });

    expect(await reconcileMergedParks(deps)).toBe(1);
    expect(getWorkflow(db, id)?.state).toBe("cancelled");
  });

  test("an open PR (a live review park) is left alone", async () => {
    const id = seedParked(52);
    const { deps, removed } = makeDeps({ 52: { number: 93, state: "OPEN" } });

    expect(await reconcileMergedParks(deps)).toBe(0);
    expect(getWorkflow(db, id)?.state).toBe("waiting-human");
    expect(removed).toEqual([]); // no teardown for a still-open PR
  });

  test("no PR for the Epic (a pending question) is left alone", async () => {
    const id = seedParked(53);
    const { deps } = makeDeps({}); // findEpicPrLifecycle → null

    expect(await reconcileMergedParks(deps)).toBe(0);
    expect(getWorkflow(db, id)?.state).toBe("waiting-human");
  });

  test("finalizes the row even when worktree teardown throws (best-effort)", async () => {
    const id = seedParked(54);
    const deps = {
      db,
      github: {
        async findEpicPrLifecycle(): Promise<EpicPrLifecycle> {
          return { number: 94, state: "MERGED" };
        },
        async getRateLimit() {
          return { remaining: 5000, resetAt: 0 };
        },
      },
      removeWorktree: async () => {
        throw new Error("git worktree remove failed");
      },
    };
    expect(await reconcileMergedParks(deps)).toBe(1);
    expect(getWorkflow(db, id)?.state).toBe("completed"); // teardown failure didn't block it
  });

  test("only walks `waiting-human` rows — running/terminal rows are untouched", async () => {
    const running = seedParked(55);
    updateWorkflow(db, running, { state: "running" });
    const done = seedParked(56);
    updateWorkflow(db, done, { state: "completed" });
    const { deps } = makeDeps({
      55: { number: 1, state: "MERGED" },
      56: { number: 2, state: "MERGED" },
    });

    expect(await reconcileMergedParks(deps)).toBe(0);
    expect(getWorkflow(db, running)?.state).toBe("running");
    expect(getWorkflow(db, done)?.state).toBe("completed");
  });

  test("skips the whole pass when the GitHub budget is below the buffer", async () => {
    const id = seedParked(57);
    const { deps } = makeDeps({ 57: { number: 95, state: "MERGED" } }, { remaining: 10 });

    expect(await reconcileMergedParks({ ...deps, rateLimitBuffer: 100 })).toBe(0);
    expect(getWorkflow(db, id)?.state).toBe("waiting-human"); // untouched — budget-gated
  });

  test("fires onMergedTransition once per MERGED transition observed (Epic #168 wiring)", async () => {
    seedParked(70);
    seedParked(71);
    seedParked(72);
    const { deps } = makeDeps({
      70: { number: 1, state: "MERGED" },
      71: { number: 2, state: "CLOSED" }, // not MERGED → does NOT trigger the hook
      72: { number: 3, state: "MERGED" },
    });

    const triggered: string[] = [];
    await reconcileMergedParks({
      ...deps,
      onMergedTransition: async (repo) => {
        triggered.push(repo);
      },
    });

    // Two MERGED transitions observed → hook fired twice (per-pass de-dup is
    // the caller's job; the daemon's reconcileOpenPRsForRepo is itself idempotent).
    expect(triggered).toEqual([REPO, REPO]);
  });

  test("a thrown onMergedTransition is isolated — the merged-parks pass still finishes", async () => {
    const idA = seedParked(75);
    const idB = seedParked(76);
    const { deps } = makeDeps({
      75: { number: 4, state: "MERGED" },
      76: { number: 5, state: "MERGED" },
    });
    const triggered: string[] = [];
    expect(
      await reconcileMergedParks({
        ...deps,
        onMergedTransition: async () => {
          triggered.push("called");
          throw new Error("downstream sweep boom");
        },
      }),
    ).toBe(2);
    expect(triggered.length).toBe(2);
    expect(getWorkflow(db, idA)?.state).toBe("completed");
    expect(getWorkflow(db, idB)?.state).toBe("completed");
  });

  test("honors the per-pass burst cap", async () => {
    seedParked(60);
    seedParked(61);
    seedParked(62);
    const { deps } = makeDeps({
      60: { number: 1, state: "MERGED" },
      61: { number: 2, state: "MERGED" },
      62: { number: 3, state: "MERGED" },
    });
    expect(await reconcileMergedParks({ ...deps, maxPollsPerPass: 2 })).toBe(2);
  });

  test("does not tear down the worktree when it loses the race to a concurrent resume", async () => {
    // Row passes the parked-row scan, but a resume advances it before the write:
    // model that by stubbing the lifecycle call to flip the row to `running`
    // just before reconcile finalizes it.
    const id = seedParked(63);
    const removed: string[] = [];
    const deps = {
      db,
      github: {
        async findEpicPrLifecycle(): Promise<EpicPrLifecycle> {
          updateWorkflow(db, id, { state: "running" }); // the concurrent resume wins
          return { number: 96, state: "MERGED" };
        },
        async getRateLimit() {
          return { remaining: 5000, resetAt: 0 };
        },
      },
      removeWorktree: async (_repo: string, wp: string | null) => {
        if (wp) removed.push(wp);
      },
    };
    expect(await reconcileMergedParks(deps)).toBe(0); // guarded write found no waiting-human row
    expect(getWorkflow(db, id)?.state).toBe("running"); // not clobbered
    expect(removed).toEqual([]); // worktree left intact for the resume
  });
});

describe("finalizeParkedWorkflow", () => {
  test("transitions a still-parked row and reports the change", () => {
    const id = seedParked(80);
    expect(finalizeParkedWorkflow(db, id, "completed")).toBe(true);
    expect(getWorkflow(db, id)?.state).toBe("completed");
  });

  test("no-ops (returns false) a row that already left waiting-human", () => {
    const id = seedParked(81);
    updateWorkflow(db, id, { state: "running" });
    expect(finalizeParkedWorkflow(db, id, "completed")).toBe(false);
    expect(getWorkflow(db, id)?.state).toBe("running"); // not clobbered
  });
});
