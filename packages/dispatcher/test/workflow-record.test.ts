import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAndMigrate } from "../src/db.ts";
import { createWorkflowRecord, getWorkflow, updateWorkflow } from "../src/workflow-record.ts";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "middle-wfrec-"));
  db = openAndMigrate(join(dir, "db.sqlite3"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("createWorkflowRecord", () => {
  test("inserts a pending implementation row carrying epic_number", () => {
    createWorkflowRecord(db, {
      id: "exec-1",
      kind: "implementation",
      repo: "thejustinwalsh/middle",
      epicNumber: 6,
      adapter: "claude",
    });
    const row = getWorkflow(db, "exec-1");
    expect(row).not.toBeNull();
    expect(row!.state).toBe("pending");
    expect(row!.epicNumber).toBe(6);
    expect(row!.repo).toBe("thejustinwalsh/middle");
    expect(row!.bunqueueExecutionId).toBe("exec-1");
    expect(row!.controlledBy).toBe("middle");
  });
});

describe("updateWorkflow", () => {
  test("transitions state and bumps updated_at", async () => {
    createWorkflowRecord(db, {
      id: "exec-1",
      kind: "implementation",
      repo: "o/r",
      epicNumber: 6,
      adapter: "claude",
    });
    const before = getWorkflow(db, "exec-1")!.updatedAt;
    await Bun.sleep(2);
    updateWorkflow(db, "exec-1", { state: "launching" });
    const after = getWorkflow(db, "exec-1")!;
    expect(after.state).toBe("launching");
    expect(after.updatedAt).toBeGreaterThan(before);
  });

  test("patches session fields without disturbing others", () => {
    createWorkflowRecord(db, {
      id: "exec-1",
      kind: "implementation",
      repo: "o/r",
      epicNumber: 6,
      adapter: "claude",
    });
    updateWorkflow(db, "exec-1", { worktreePath: "/wt/issue-6" });
    updateWorkflow(db, "exec-1", {
      state: "running",
      sessionName: "middle-6",
      sessionId: "sess-abc",
      transcriptPath: "/t/abc.jsonl",
    });
    const row = getWorkflow(db, "exec-1")!;
    expect(row.state).toBe("running");
    expect(row.worktreePath).toBe("/wt/issue-6");
    expect(row.sessionName).toBe("middle-6");
    expect(row.sessionId).toBe("sess-abc");
    expect(row.transcriptPath).toBe("/t/abc.jsonl");
  });

  test("a no-op patch leaves the row intact", () => {
    createWorkflowRecord(db, {
      id: "exec-1",
      kind: "implementation",
      repo: "o/r",
      epicNumber: 6,
      adapter: "claude",
    });
    updateWorkflow(db, "exec-1", {});
    expect(getWorkflow(db, "exec-1")!.state).toBe("pending");
  });
});

describe("getWorkflow", () => {
  test("returns null for an unknown id", () => {
    expect(getWorkflow(db, "nope")).toBeNull();
  });
});
