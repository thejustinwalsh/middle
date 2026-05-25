/**
 * Shared test scaffolding: a migrated temp db, a minimal `MiddleConfig`, and
 * workflow-row seeding helpers. Dashboard tests build their deps from these so
 * each exercises the real db-backed seam, not a hand-rolled fake.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { MiddleConfig } from "@middle/core";
import { openAndMigrate } from "@middle/dispatcher/src/db.ts";
import {
  createWorkflowRecord,
  updateWorkflow,
  type WorkflowState,
} from "@middle/dispatcher/src/workflow-record.ts";

/** A migrated db on a real temp file (WAL needs a path, not `:memory:`). */
export function makeDb(): { db: Database; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "middle-dashboard-"));
  const db = openAndMigrate(join(dir, "db.sqlite3"));
  return {
    db,
    dir,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A minimal merged config — slot caps + default adapter the deps read. */
export function makeConfig(overrides: Partial<MiddleConfig> = {}): MiddleConfig {
  return {
    global: {
      dispatcherPort: 4120,
      maxConcurrent: 4,
      defaultAdapter: "claude",
      logDir: "/tmp/logs",
      worktreeRoot: "/tmp/worktrees",
      dbPath: "/tmp/db.sqlite3",
    },
    adapters: {
      claude: { enabled: true, binary: "claude", extraArgs: [] },
      codex: { enabled: true, binary: "codex", extraArgs: [] },
    },
    dashboard: { windowed: false, theme: "auto" },
    limits: {
      maxConcurrent: 3,
      maxConcurrentPerAdapter: { claude: 2, codex: 1 },
      complexityCeiling: 3,
    },
    ...overrides,
  };
}

/** Options for {@link seedWorkflow} — the columns dashboard reads. */
export type SeedWorkflow = {
  id: string;
  repo: string;
  epicNumber?: number | null;
  adapter?: string;
  state?: WorkflowState;
  sessionName?: string;
  controlledBy?: "middle" | "human";
  transcriptPath?: string;
  worktreePath?: string;
  currentSubIssue?: number;
  prNumber?: number;
  prBranch?: string;
  lastHeartbeat?: number;
};

/** Insert an implementation workflow row with the given fields set. */
export function seedWorkflow(db: Database, w: SeedWorkflow): void {
  createWorkflowRecord(db, {
    id: w.id,
    kind: "implementation",
    repo: w.repo,
    epicNumber: w.epicNumber ?? null,
    adapter: w.adapter ?? "claude",
  });
  updateWorkflow(db, w.id, {
    state: w.state ?? "running",
    sessionName: w.sessionName,
    controlledBy: w.controlledBy,
    transcriptPath: w.transcriptPath,
    worktreePath: w.worktreePath,
  });
  // Columns updateWorkflow doesn't cover — set directly.
  if (w.currentSubIssue !== undefined) {
    db.run("UPDATE workflows SET current_sub_issue = ? WHERE id = ?", [w.currentSubIssue, w.id]);
  }
  if (w.prNumber !== undefined) {
    db.run("UPDATE workflows SET pr_number = ? WHERE id = ?", [w.prNumber, w.id]);
  }
  if (w.prBranch !== undefined) {
    db.run("UPDATE workflows SET pr_branch = ? WHERE id = ?", [w.prBranch, w.id]);
  }
  if (w.lastHeartbeat !== undefined) {
    db.run("UPDATE workflows SET last_heartbeat = ? WHERE id = ?", [w.lastHeartbeat, w.id]);
  }
}
