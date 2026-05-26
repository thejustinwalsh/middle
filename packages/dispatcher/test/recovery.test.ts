import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, Workflow } from "bunqueue/workflow";
import { shutdownManager } from "bunqueue/client";
import { openAndMigrate } from "../src/db.ts";
import {
  createDurableEngine,
  type OrphanedSignal,
  recoverEngine,
  reconcileOrphanedSignals,
} from "../src/recovery.ts";
import {
  armWaitForSignal,
  createWorkflowRecord,
  getWaitForSignal,
  getWorkflow,
  updateWorkflow,
} from "../src/workflow-record.ts";

let scratch: string;
let db: Database;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "middle-recovery-"));
  db = openAndMigrate(join(scratch, "db.sqlite3"));
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const REPO = "thejustinwalsh/middle";

/** Seed a parked (`waiting-human`) implementation workflow with an armed resume signal. */
function seedParked(epic: number | null, signalName: string): string {
  const id = crypto.randomUUID();
  createWorkflowRecord(db, {
    id,
    kind: "implementation",
    repo: REPO,
    epicNumber: epic,
    adapter: "claude",
  });
  updateWorkflow(db, id, { state: "waiting-human" });
  armWaitForSignal(db, signalName, id, JSON.stringify({ reason: "review-changes" }));
  return id;
}

describe("reconcileOrphanedSignals", () => {
  test("an armed signal with no recoverable execution is finalized failed, consumed, and surfaced", async () => {
    const id = seedParked(6, "epic-6-review-resolved");
    const surfaced: OrphanedSignal[] = [];

    const orphans = await reconcileOrphanedSignals({
      db,
      hasExecution: () => false, // the store has no execution for it → orphan
      surface: (o) => {
        surfaced.push(o);
      },
    });

    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({
      workflowId: id,
      repo: REPO,
      epicNumber: 6,
      signalName: "epic-6-review-resolved",
    });
    // Finalized to a terminal state so the poller stops watching it (its
    // `loadPollableWaits` only sees `waiting-human` rows).
    expect(getWorkflow(db, id)?.state).toBe("failed");
    // Signal row consumed so nothing dangles.
    expect(getWaitForSignal(db, id)).toBeNull();
    // Surfaced for human visibility.
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]?.workflowId).toBe(id);
  });

  test("a recoverable parked execution is left untouched (not an orphan)", async () => {
    const id = seedParked(7, "epic-7-answered");
    const surfaced: OrphanedSignal[] = [];

    const orphans = await reconcileOrphanedSignals({
      db,
      hasExecution: () => true, // recover() re-armed it; it is alive
      surface: (o) => {
        surfaced.push(o);
      },
    });

    expect(orphans).toHaveLength(0);
    expect(getWorkflow(db, id)?.state).toBe("waiting-human");
    expect(getWaitForSignal(db, id)?.signalName).toBe("epic-7-answered");
    expect(surfaced).toHaveLength(0);
  });

  test("only the orphaned rows are reconciled when alive and orphaned parks coexist", async () => {
    const orphan = seedParked(6, "epic-6-review-resolved");
    const alive = seedParked(7, "epic-7-answered");

    const orphans = await reconcileOrphanedSignals({
      db,
      hasExecution: (workflowId) => workflowId === alive,
    });

    expect(orphans.map((o) => o.workflowId)).toEqual([orphan]);
    expect(getWorkflow(db, orphan)?.state).toBe("failed");
    expect(getWorkflow(db, alive)?.state).toBe("waiting-human");
  });

  test("respects a custom finalState and tolerates a missing surface callback", async () => {
    const id = seedParked(8, "epic-8-answered");

    const orphans = await reconcileOrphanedSignals({
      db,
      hasExecution: () => false,
      finalState: "cancelled",
    });

    expect(orphans).toHaveLength(1);
    expect(getWorkflow(db, id)?.state).toBe("cancelled");
    expect(getWaitForSignal(db, id)).toBeNull();
  });

  test("a surface callback that throws never aborts the reconcile (still finalized + consumed)", async () => {
    const id = seedParked(9, "epic-9-answered");

    const orphans = await reconcileOrphanedSignals({
      db,
      hasExecution: () => false,
      surface: () => {
        throw new Error("comment failed");
      },
    });

    expect(orphans).toHaveLength(1);
    expect(getWorkflow(db, id)?.state).toBe("failed");
    expect(getWaitForSignal(db, id)).toBeNull();
  });

  test("an orphaned signal with a null epicNumber still reconciles", async () => {
    const id = seedParked(null, "blocked:standalone");
    const surfaced: OrphanedSignal[] = [];

    const orphans = await reconcileOrphanedSignals({
      db,
      hasExecution: () => false,
      surface: (o) => {
        surfaced.push(o);
      },
    });

    expect(orphans).toHaveLength(1);
    expect(surfaced[0]?.epicNumber).toBeNull();
    expect(getWorkflow(db, id)?.state).toBe("failed");
  });

  test("a non-parked (terminal) workflow's stale signal is ignored — only waiting-human rows are pollable", async () => {
    // A row that already advanced past the park keeps any leftover signal row, but
    // `loadPollableWaits` only joins `waiting-human` rows, so reconcile never sees it.
    const id = crypto.randomUUID();
    createWorkflowRecord(db, {
      id,
      kind: "implementation",
      repo: REPO,
      epicNumber: 10,
      adapter: "claude",
    });
    armWaitForSignal(db, "epic-10-answered", id, null);
    updateWorkflow(db, id, { state: "completed" });

    const orphans = await reconcileOrphanedSignals({ db, hasExecution: () => false });

    expect(orphans).toHaveLength(0);
    expect(getWorkflow(db, id)?.state).toBe("completed");
  });
});

/**
 * `recoverEngine` against a real bunqueue Engine on a persistent `dataPath`. A
 * restart is simulated by `engine.close(true)` + `shutdownManager()` (resetting
 * bunqueue's process-singleton queue manager) before constructing the second
 * Engine on the same path — modelling the fresh module state of a real
 * separate-process daemon restart.
 */
describe("recoverEngine (durable engine across restart)", () => {
  let dir: string;
  let dataPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "middle-engine-"));
    dataPath = join(dir, "queue.sqlite3");
  });

  afterEach(() => {
    shutdownManager();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A minimal workflow that parks on `waitFor("go")`, then records the resume payload. */
  function parkingFlow(onResume: (payload: unknown) => void): Workflow<{ n: number }> {
    return new Workflow<{ n: number }>("parker")
      .step("before", async () => {})
      .waitFor("go", { timeout: 7 * 24 * 3600 * 1000 })
      .step("after", (ctx) => {
        onResume((ctx.signals as Record<string, unknown>).go);
      });
  }

  async function awaitState(engine: Engine, id: string, want: string, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (engine.getExecution(id)?.state === want) return;
      await Bun.sleep(10);
    }
    throw new Error(
      `execution ${id} did not reach '${want}' (was '${engine.getExecution(id)?.state}')`,
    );
  }

  test("re-arms a parked waiting execution so a later signal resumes it", async () => {
    const e1 = createDurableEngine(dataPath);
    e1.register(parkingFlow(() => {}));
    const { id } = await e1.start("parker", { n: 1 });
    await awaitState(e1, id, "waiting");
    await e1.close(true);
    shutdownManager(); // simulate a separate-process restart

    let resumePayload: unknown;
    const e2 = createDurableEngine(dataPath);
    e2.register(
      parkingFlow((p) => {
        resumePayload = p;
      }),
    );
    // The durable store survived: the fresh engine sees the parked execution.
    expect(e2.getExecution(id)?.state).toBe("waiting");

    const result = await recoverEngine(e2);
    expect(result.recovered.waiting).toBe(1);
    expect(result.cleared).toBe(0); // nothing mid-drive to drop

    // A resume signal (with a payload — an undefined payload would re-park) advances it.
    await e2.signal(id, "go", { reason: "answered-question" });
    await awaitState(e2, id, "completed");
    expect(resumePayload).toEqual({ reason: "answered-question" });
    await e2.close(true);
  });

  test("drops a mid-drive (running) execution instead of re-driving it", async () => {
    // A step that blocks on a gate we never release keeps the execution `running`.
    let released = false;
    const gate = new Promise<void>((resolve) => {
      // resolve is intentionally never called before the restart; satisfy the
      // type by stashing it where the after-restart engine can't reach it.
      void resolve;
    });
    let secondAttempt = false;
    const blockingFlow = () =>
      new Workflow<{ n: number }>("runner").step("block", async () => {
        if (released) secondAttempt = true;
        await gate;
      });

    const e1 = createDurableEngine(dataPath);
    e1.register(blockingFlow());
    const { id } = await e1.start("runner", { n: 1 });
    await awaitState(e1, id, "running");
    await e1.close(true);
    shutdownManager();

    released = true; // would flip if the step re-ran after restart
    const e2 = createDurableEngine(dataPath);
    e2.register(blockingFlow());
    const result = await recoverEngine(e2);

    // The mid-drive exec was cleared, not recovered/re-driven.
    expect(result.cleared).toBe(1);
    expect(result.recovered.running).toBe(0);
    expect(e2.getExecution(id)).toBeNull();
    // Give any erroneously re-enqueued step a chance to run, then assert it didn't.
    await Bun.sleep(50);
    expect(secondAttempt).toBe(false);
    await e2.close(true);
  });
});
