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
