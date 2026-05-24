import type { Database } from "bun:sqlite";

/** The lifecycle states a `workflows` row moves through (mirrors the schema CHECK). */
export type WorkflowState =
  | "pending"
  | "launching"
  | "running"
  | "waiting-human"
  | "rate-limited"
  | "completed"
  | "compensated"
  | "failed"
  | "cancelled";

export type WorkflowRecord = {
  id: string;
  kind: "implementation" | "recommender";
  repo: string;
  epicNumber: number | null;
  adapter: string;
  state: WorkflowState;
  createdAt: number;
  updatedAt: number;
  bunqueueExecutionId: string | null;
  worktreePath: string | null;
  sessionName: string | null;
  sessionToken: string | null;
  sessionId: string | null;
  transcriptPath: string | null;
  controlledBy: "middle" | "human";
};

export type CreateWorkflowRecordInput = {
  id: string;
  kind: "implementation" | "recommender";
  repo: string;
  epicNumber: number | null;
  adapter: string;
};

/** Insert a fresh `pending` workflow row. `id` doubles as the bunqueue execution id. */
export function createWorkflowRecord(db: Database, input: CreateWorkflowRecordInput): void {
  const now = Date.now();
  db.run(
    `INSERT INTO workflows
       (id, kind, repo, epic_number, adapter, state, created_at, updated_at, bunqueue_execution_id)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [input.id, input.kind, input.repo, input.epicNumber, input.adapter, now, now, input.id],
  );
}

export type WorkflowPatch = {
  state?: WorkflowState;
  worktreePath?: string;
  sessionName?: string;
  sessionToken?: string;
  sessionId?: string;
  transcriptPath?: string;
};

const PATCH_COLUMNS: Record<keyof WorkflowPatch, string> = {
  state: "state",
  worktreePath: "worktree_path",
  sessionName: "session_name",
  sessionToken: "session_token",
  sessionId: "session_id",
  transcriptPath: "transcript_path",
};

/** Patch the given fields on a workflow row; always bumps `updated_at`. A no-op patch still touches `updated_at`. */
export function updateWorkflow(db: Database, id: string, patch: WorkflowPatch): void {
  const sets: string[] = ["updated_at = ?"];
  const values: (string | number)[] = [Date.now()];
  for (const [key, column] of Object.entries(PATCH_COLUMNS) as [keyof WorkflowPatch, string][]) {
    const value = patch[key];
    if (value !== undefined) {
      sets.push(`${column} = ?`);
      values.push(value);
    }
  }
  values.push(id);
  db.run(`UPDATE workflows SET ${sets.join(", ")} WHERE id = ?`, values);
}

/**
 * The terminal states. A workflow in one of these no longer owns its session,
 * so its hooks are stale and must not be correlated to it — `session.started`
 * for a *new* dispatch reusing a deterministic session name would otherwise
 * attach to the corpse.
 */
const TERMINAL_STATES = ["completed", "compensated", "failed", "cancelled"] as const;

export type ActiveWorkflow = { id: string; sessionToken: string | null };

/**
 * The active (non-terminal) workflow owning `sessionName`, or null. Session
 * names are deterministic and reused across dispatches, so this filters to
 * non-terminal rows and takes the most recent — the one a live agent's hooks
 * belong to.
 */
export function findActiveWorkflowBySession(
  db: Database,
  sessionName: string,
): ActiveWorkflow | null {
  const placeholders = TERMINAL_STATES.map(() => "?").join(", ");
  const row = db
    .query(
      `SELECT id, session_token FROM workflows
        WHERE session_name = ? AND state NOT IN (${placeholders})
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1`,
    )
    .get(sessionName, ...TERMINAL_STATES) as
    | { id: string; session_token: string | null }
    | null;
  if (!row) return null;
  return { id: row.id, sessionToken: row.session_token };
}

export type RecordEventInput = {
  workflowId: string;
  ts: number;
  type: string;
  payloadJson: string | null;
};

/** Append one `events` row. The payload is expected pre-truncated by the caller. */
export function recordEvent(db: Database, input: RecordEventInput): void {
  db.run("INSERT INTO events (workflow_id, ts, type, payload_json) VALUES (?, ?, ?, ?)", [
    input.workflowId,
    input.ts,
    input.type,
    input.payloadJson,
  ]);
}

/** Advance a workflow's `last_heartbeat` (and `updated_at`) to `ts`. */
export function touchHeartbeat(db: Database, id: string, ts: number): void {
  db.run("UPDATE workflows SET last_heartbeat = ?, updated_at = ? WHERE id = ?", [ts, ts, id]);
}

/** Whether any `events` row of this type exists for the workflow. */
export function hasEventOfType(db: Database, workflowId: string, type: string): boolean {
  const row = db
    .query("SELECT 1 AS n FROM events WHERE workflow_id = ? AND type = ? LIMIT 1")
    .get(workflowId, type) as { n: number } | null;
  return row !== null;
}

/** Timestamp of the earliest `events` row of this type for the workflow, or null. */
export function firstEventTs(db: Database, workflowId: string, type: string): number | null {
  const row = db
    .query("SELECT ts FROM events WHERE workflow_id = ? AND type = ? ORDER BY ts ASC LIMIT 1")
    .get(workflowId, type) as { ts: number } | null;
  return row?.ts ?? null;
}

/** The `type` of the most recent `events` row for a workflow, or null if none. */
export function latestEventType(db: Database, workflowId: string): string | null {
  const row = db
    .query("SELECT type FROM events WHERE workflow_id = ? ORDER BY id DESC LIMIT 1")
    .get(workflowId) as { type: string } | null;
  return row?.type ?? null;
}

/** Whether a `waitFor` signal is already armed for this workflow. */
export function isWaitForArmed(db: Database, workflowId: string): boolean {
  const row = db
    .query("SELECT 1 AS n FROM waitfor_signals WHERE workflow_id = ? LIMIT 1")
    .get(workflowId) as { n: number } | null;
  return row !== null;
}

/**
 * Arm a `waitFor` signal for a workflow. `signal_name` is the table's primary
 * key, so this is a no-op if the same signal is already armed (the watchdog may
 * re-run before the workflow advances).
 */
export function armWaitForSignal(
  db: Database,
  signalName: string,
  workflowId: string,
  payloadJson: string | null = null,
): void {
  db.run(
    "INSERT OR IGNORE INTO waitfor_signals (signal_name, workflow_id, created_at, payload_json) VALUES (?, ?, ?, ?)",
    [signalName, workflowId, Date.now(), payloadJson],
  );
}

export type ArmedSignal = { signalName: string; payloadJson: string | null };

/**
 * The signal armed for this workflow, or null. The poller reads this to learn
 * what an Epic is waiting on (the epic-scoped, reason-scoped `signal_name`)
 * without consuming it; only a successful resume consumes the row.
 */
export function getWaitForSignal(db: Database, workflowId: string): ArmedSignal | null {
  const row = db
    .query(
      "SELECT signal_name, payload_json FROM waitfor_signals WHERE workflow_id = ? LIMIT 1",
    )
    .get(workflowId) as { signal_name: string; payload_json: string | null } | null;
  if (!row) return null;
  return { signalName: row.signal_name, payloadJson: row.payload_json };
}

/**
 * Consume (delete) the armed signal for a workflow on resume, returning what it
 * was. The durable `waitfor_signals` row is middle's own record that the
 * workflow is parked — distinct from bunqueue's in-memory `exec.signals`. It is
 * armed when the workflow parks and consumed exactly once when it resumes, so a
 * resumed workflow no longer reads as waiting and the poller stops watching it.
 */
export function consumeWaitForSignal(db: Database, workflowId: string): ArmedSignal | null {
  const armed = getWaitForSignal(db, workflowId);
  if (armed) db.run("DELETE FROM waitfor_signals WHERE workflow_id = ?", [workflowId]);
  return armed;
}

type WorkflowRow = {
  id: string;
  kind: string;
  repo: string;
  epic_number: number | null;
  adapter: string;
  state: string;
  created_at: number;
  updated_at: number;
  bunqueue_execution_id: string | null;
  worktree_path: string | null;
  session_name: string | null;
  session_token: string | null;
  session_id: string | null;
  transcript_path: string | null;
  controlled_by: string;
};

/** Fetch a workflow row by id, or null if it does not exist. */
export function getWorkflow(db: Database, id: string): WorkflowRecord | null {
  const row = db.query("SELECT * FROM workflows WHERE id = ?").get(id) as WorkflowRow | null;
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind as WorkflowRecord["kind"],
    repo: row.repo,
    epicNumber: row.epic_number,
    adapter: row.adapter,
    state: row.state as WorkflowState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    bunqueueExecutionId: row.bunqueue_execution_id,
    worktreePath: row.worktree_path,
    sessionName: row.session_name,
    sessionToken: row.session_token,
    sessionId: row.session_id,
    transcriptPath: row.transcript_path,
    controlledBy: row.controlled_by as WorkflowRecord["controlledBy"],
  };
}
