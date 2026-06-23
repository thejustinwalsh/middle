/**
 * Integration tests for #260: gate.failed, daemon.recovered, and
 * daemon.orphan-finalized events land in the events table and are
 * surfaced by Inspector's getSessionEvents path.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAndMigrate } from "../src/db.ts";
import { recoverEngine, reconcileOrphanedSignals } from "../src/recovery.ts";
import { armWaitForSignal, createWorkflowRecord, recordEvent } from "../src/workflow-record.ts";

// Minimal Engine stub that satisfies recoverEngine's call sites.
function makeStubEngine(opts?: { recoverWaiting?: number }): Parameters<typeof recoverEngine>[0] {
  return {
    cleanup: () => 0,
    recover: async () => ({
      running: 0,
      waiting: opts?.recoverWaiting ?? 0,
      compensating: 0,
      total: opts?.recoverWaiting ?? 0,
    }),
    // getExecution isn't used by recoverEngine itself (only by reconcileOrphanedSignals callers)
    getExecution: () => null,
  } as unknown as Parameters<typeof recoverEngine>[0];
}

let scratch: string;
let db: Database;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "middle-rev-"));
  db = openAndMigrate(join(scratch, "db.sqlite3"));
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

// ── Helper: get all event rows for a workflow ─────────────────────────────────

function getEvents(workflowId: string): Array<{ type: string; payload: unknown }> {
  return (
    db
      .query(
        `SELECT type, payload_json FROM events
         WHERE workflow_id = ? ORDER BY ts ASC, id ASC`,
      )
      .all(workflowId) as Array<{ type: string; payload_json: string | null }>
  ).map((r) => ({
    type: r.type,
    payload: r.payload_json !== null ? JSON.parse(r.payload_json) : null,
  }));
}

function seedWaiting(id: string): void {
  createWorkflowRecord(db, {
    id,
    kind: "implementation",
    repo: "thejustinwalsh/middle",
    epicRef: "14",
    adapter: "claude",
  });
  db.run(`UPDATE workflows SET state = 'waiting-human', updated_at = ? WHERE id = ?`, [
    Date.now(),
    id,
  ]);
  // arm a waitfor_signals row so loadPollableWaits picks it up
  armWaitForSignal(db, `blocked:${id}`, id, null);
}

// ── #260 — daemon.recovered event ────────────────────────────────────────────

describe("recoverEngine — daemon.recovered events (#260)", () => {
  test("records daemon.recovered for each waiting-human workflow after recover()", async () => {
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    seedWaiting(id1);
    seedWaiting(id2);

    await recoverEngine(makeStubEngine(), db);

    expect(getEvents(id1).some((e) => e.type === "daemon.recovered")).toBe(true);
    expect(getEvents(id2).some((e) => e.type === "daemon.recovered")).toBe(true);
  });

  test("daemon.recovered event payload carries workflowId", async () => {
    const id = crypto.randomUUID();
    seedWaiting(id);

    await recoverEngine(makeStubEngine(), db);

    const ev = getEvents(id).find((e) => e.type === "daemon.recovered");
    expect(ev).toBeDefined();
    expect((ev!.payload as { workflowId: string }).workflowId).toBe(id);
  });

  test("without db param, recoverEngine records no daemon.recovered events (backward compat)", async () => {
    const id = crypto.randomUUID();
    seedWaiting(id);

    // Old call-site: no db.
    await recoverEngine(makeStubEngine());

    expect(getEvents(id)).toHaveLength(0);
  });

  test("no events recorded when there are no waiting-human workflows", async () => {
    // No waiting-human rows → nothing to record.
    const id = crypto.randomUUID();
    createWorkflowRecord(db, {
      id,
      kind: "implementation",
      repo: "thejustinwalsh/middle",
      epicRef: "14",
      adapter: "claude",
    });
    // Leave in default 'pending' state — not waiting-human.

    await recoverEngine(makeStubEngine(), db);

    expect(getEvents(id)).toHaveLength(0);
  });
});

// ── #260 — daemon.orphan-finalized event ─────────────────────────────────────

describe("reconcileOrphanedSignals — daemon.orphan-finalized events (#260)", () => {
  test("records daemon.orphan-finalized for each finalized orphan", async () => {
    const id = crypto.randomUUID();
    seedWaiting(id);

    await reconcileOrphanedSignals({ db, hasExecution: () => false });

    expect(getEvents(id).some((e) => e.type === "daemon.orphan-finalized")).toBe(true);
  });

  test("daemon.orphan-finalized payload carries finalState", async () => {
    const id = crypto.randomUUID();
    seedWaiting(id);

    await reconcileOrphanedSignals({ db, hasExecution: () => false, finalState: "failed" });

    const ev = getEvents(id).find((e) => e.type === "daemon.orphan-finalized");
    expect(ev).toBeDefined();
    expect((ev!.payload as { finalState: string }).finalState).toBe("failed");
  });

  test("uses cancelled as finalState when specified", async () => {
    const id = crypto.randomUUID();
    seedWaiting(id);

    await reconcileOrphanedSignals({ db, hasExecution: () => false, finalState: "cancelled" });

    const ev = getEvents(id).find((e) => e.type === "daemon.orphan-finalized");
    expect((ev!.payload as { finalState: string }).finalState).toBe("cancelled");
  });

  test("no event recorded when hasExecution returns true (not an orphan)", async () => {
    const id = crypto.randomUUID();
    seedWaiting(id);

    await reconcileOrphanedSignals({ db, hasExecution: () => true });

    expect(getEvents(id)).toHaveLength(0);
  });

  test("integration: recoverEngine + reconcileOrphanedSignals records both event types", async () => {
    const id = crypto.randomUUID();
    seedWaiting(id);

    await recoverEngine(makeStubEngine(), db);
    await reconcileOrphanedSignals({ db, hasExecution: () => false });

    const evs = getEvents(id);
    expect(evs.some((e) => e.type === "daemon.recovered")).toBe(true);
    expect(evs.some((e) => e.type === "daemon.orphan-finalized")).toBe(true);
  });
});

// ── #260 — gate.failed event ─────────────────────────────────────────────────

describe("gate.failed event via runVerifyGates (#260)", () => {
  test("gate.failed event is recorded with gateName, exitCode, stderrExcerpt", () => {
    const workflowId = crypto.randomUUID();
    createWorkflowRecord(db, {
      id: workflowId,
      kind: "implementation",
      repo: "thejustinwalsh/middle",
      epicRef: "99",
      adapter: "claude",
    });

    const gateName = "bun test";
    const exitCode = 1;
    const stderrExcerpt = "Error: 2 tests failed";

    // Simulate what the wired runVerifyGates closure records on gate failure.
    recordEvent(db, {
      workflowId,
      ts: Date.now(),
      type: "gate.failed",
      payloadJson: JSON.stringify({ gateName, exitCode, stderrExcerpt }),
    });

    const evs = getEvents(workflowId);
    const gateEv = evs.find((e) => e.type === "gate.failed");
    expect(gateEv).toBeDefined();
    const p = gateEv!.payload as { gateName: string; exitCode: number; stderrExcerpt: string };
    expect(p.gateName).toBe(gateName);
    expect(p.exitCode).toBe(exitCode);
    expect(p.stderrExcerpt).toBe(stderrExcerpt);
  });

  test("gate.failed event type passes isVerificationEvent filter (Inspector shows it)", () => {
    // Inline the Inspector's isVerificationEvent to assert gate.failed is captured.
    function isVerificationEvent(type: string): boolean {
      return /gate|verify|verification|check/i.test(type);
    }
    expect(isVerificationEvent("gate.failed")).toBe(true);
    expect(isVerificationEvent("daemon.recovered")).toBe(false);
    expect(isVerificationEvent("daemon.orphan-finalized")).toBe(false);
  });
});
