import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAndMigrate } from "../src/db.ts";
import {
  collectRetentionStatus,
  EVENTS_MAX_AGE_MS,
  getLatestRetentionRun,
  recordRetentionRun,
  runRetentionPass,
  WORKFLOWS_MAX_AGE_MS,
} from "../src/retention.ts";

const NOW = 1_900_000_000_000; // fixed clock; all ages are relative to this
const DAY = 24 * 60 * 60 * 1000;

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "middle-retention-"));
  db = openAndMigrate(join(dir, "db.sqlite3"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function insertWorkflow(
  id: string,
  opts: { state?: string; updatedAt?: number; meta?: string } = {},
): void {
  db.run(
    `INSERT INTO workflows (id, kind, repo, adapter, state, created_at, updated_at, meta_json)
     VALUES (?, 'implementation', 'o/r', 'claude', ?, ?, ?, ?)`,
    [id, opts.state ?? "completed", 1, opts.updatedAt ?? NOW, opts.meta ?? null],
  );
}

function insertEvent(workflowId: string, ts: number): void {
  db.run(`INSERT INTO events (workflow_id, ts, type) VALUES (?, ?, 'session.started')`, [
    workflowId,
    ts,
  ]);
}

function eventCount(): number {
  return (db.query("SELECT count(*) AS c FROM events").get() as { c: number }).c;
}

describe("runRetentionPass — events cutoff (14d)", () => {
  test("deletes events older than 14 days, keeps newer ones", () => {
    insertWorkflow("w1", { state: "running", updatedAt: NOW });
    insertEvent("w1", NOW - EVENTS_MAX_AGE_MS - 1); // just over the line → deleted
    insertEvent("w1", NOW - EVENTS_MAX_AGE_MS + DAY); // inside the window → kept
    insertEvent("w1", NOW); // fresh → kept

    const result = runRetentionPass(db, { now: NOW });

    expect(result.eventsDeleted).toBe(1);
    expect(eventCount()).toBe(2);
  });

  test("an event exactly at the cutoff age is kept (strict `< cutoff`)", () => {
    insertWorkflow("w1", { state: "running" });
    insertEvent("w1", NOW - EVENTS_MAX_AGE_MS); // ts === cutoff → kept
    const result = runRetentionPass(db, { now: NOW });
    expect(result.eventsDeleted).toBe(0);
    expect(eventCount()).toBe(1);
  });
});

describe("runRetentionPass — workflow archival (30d, completed only)", () => {
  test("archives completed workflows older than 30 days; drops their events, preserves the row", () => {
    insertWorkflow("old", {
      state: "completed",
      updatedAt: NOW - WORKFLOWS_MAX_AGE_MS - 1,
      meta: '{"x":1}',
    });
    insertEvent("old", NOW); // fresh event, but its workflow is archived → dropped

    const result = runRetentionPass(db, { now: NOW });

    expect(result.workflowsArchived).toBe(1);
    // The row survives with its state + config snapshot…
    const row = db
      .query("SELECT state, meta_json AS meta, archived_at AS a FROM workflows WHERE id='old'")
      .get() as {
      state: string;
      meta: string;
      a: number;
    };
    expect(row.state).toBe("completed");
    expect(row.meta).toBe('{"x":1}');
    expect(row.a).toBe(NOW); // stamped
    // …but its events are gone.
    expect(eventCount()).toBe(0);
  });

  test("does not archive completed workflows inside the 30-day window", () => {
    insertWorkflow("recent", { state: "completed", updatedAt: NOW - WORKFLOWS_MAX_AGE_MS + DAY });
    const result = runRetentionPass(db, { now: NOW });
    expect(result.workflowsArchived).toBe(0);
    expect(db.query("SELECT archived_at FROM workflows WHERE id='recent'").get()).toEqual({
      archived_at: null,
    });
  });

  test("does not archive old non-completed workflows (failed/running/etc.)", () => {
    insertWorkflow("failed", { state: "failed", updatedAt: NOW - WORKFLOWS_MAX_AGE_MS - DAY });
    insertWorkflow("running", { state: "running", updatedAt: NOW - WORKFLOWS_MAX_AGE_MS - DAY });
    const result = runRetentionPass(db, { now: NOW });
    expect(result.workflowsArchived).toBe(0);
  });

  test("is idempotent — a second pass archives nothing new", () => {
    insertWorkflow("old", { state: "completed", updatedAt: NOW - WORKFLOWS_MAX_AGE_MS - DAY });
    expect(runRetentionPass(db, { now: NOW }).workflowsArchived).toBe(1);
    expect(runRetentionPass(db, { now: NOW }).workflowsArchived).toBe(0);
  });
});

describe("retention_runs recording", () => {
  test("records each pass (even a no-op) with ok=true", () => {
    runRetentionPass(db, { now: NOW });
    const last = getLatestRetentionRun(db);
    expect(last).not.toBeNull();
    expect(last!.ok).toBe(true);
    expect(last!.ranAt).toBe(NOW);
    expect(last!.eventsDeleted).toBe(0);
    expect(last!.workflowsArchived).toBe(0);
  });

  test("recordRetentionRun with a detail marks ok=false", () => {
    recordRetentionRun(db, { ranAt: NOW, eventsDeleted: 0, workflowsArchived: 0, detail: "boom" });
    const last = getLatestRetentionRun(db);
    expect(last!.ok).toBe(false);
    expect(last!.detail).toBe("boom");
  });

  test("getLatestRetentionRun returns the most recent by ran_at", () => {
    recordRetentionRun(db, { ranAt: NOW - DAY, eventsDeleted: 1, workflowsArchived: 0 });
    recordRetentionRun(db, { ranAt: NOW, eventsDeleted: 5, workflowsArchived: 2 });
    const last = getLatestRetentionRun(db);
    expect(last!.ranAt).toBe(NOW);
    expect(last!.eventsDeleted).toBe(5);
    expect(last!.workflowsArchived).toBe(2);
  });
});

describe("collectRetentionStatus", () => {
  test("reports row counts (incl. archived) and the last run", () => {
    insertWorkflow("a", { state: "completed", updatedAt: NOW - WORKFLOWS_MAX_AGE_MS - DAY });
    insertWorkflow("b", { state: "running" });
    insertEvent("b", NOW);
    runRetentionPass(db, { now: NOW }); // archives 'a'

    const status = collectRetentionStatus(db);
    expect(status.rowCounts.workflows).toBe(2);
    expect(status.rowCounts.archivedWorkflows).toBe(1);
    expect(status.rowCounts.events).toBe(1); // b's event survived
    expect(status.lastRun?.ok).toBe(true);
  });

  test("lastRun is null before any retention has run", () => {
    expect(collectRetentionStatus(db).lastRun).toBeNull();
  });
});
