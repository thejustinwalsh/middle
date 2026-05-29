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

/**
 * The terminal workflow states — settled, owns no session, accepts no further transition.
 * A strict subset of {@link WorkflowState}. Finalizers take this (not `WorkflowState`) so a
 * non-terminal value (`"running"`, `"waiting-human"`, …) can't be written as a "final"
 * state: that would consume the wait row yet strand the workflow with no recovery path.
 */
export type TerminalWorkflowState = Extract<
  WorkflowState,
  "completed" | "compensated" | "failed" | "cancelled"
>;

export type WorkflowRecord = {
  id: string;
  kind: "implementation" | "recommender" | "documentation";
  repo: string;
  epicNumber: number | null;
  /**
   * The canonical Epic reference (migration 008): `String(epicNumber)` for
   * github-mode rows, a slug for file-mode rows, null when there's no Epic
   * (recommender / documentation). Read straight from the column — the dispatch
   * write path, not this read accessor, is what populates it.
   */
  epicRef: string | null;
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
  kind: "implementation" | "recommender" | "documentation";
  repo: string;
  epicNumber: number | null;
  adapter: string;
  /**
   * How the dispatch was initiated — `"manual"` for `mm dispatch`, `"auto"` for
   * the auto-dispatch loop (build spec → "Auto-dispatch loop": manual force-
   * dispatch is "logged with `source: 'manual'`"). Persisted in `meta_json`.
   * Omitted leaves `meta_json` null (e.g. the recommender's own row).
   */
  source?: "manual" | "auto";
};

/**
 * Insert a fresh `pending` workflow row. `id` doubles as the bunqueue execution id.
 *
 * Idempotent on the `id` PK (`ON CONFLICT(id) DO NOTHING`): the workflow steps
 * that call this run under bunqueue's retry, and a retried step re-runs the
 * INSERT for the *same* execution id. A plain INSERT would throw `UNIQUE
 * constraint failed` and mask the real downstream error that triggered the
 * retry (#108). The only way the PK collides is a same-execution retry —
 * exactly the case we want to no-op — so the second call leaves the existing
 * (possibly already advanced) row untouched and lets the real error surface.
 *
 * Scoped to the PK conflict (not a blanket `INSERT OR IGNORE`) on purpose: a
 * genuine CHECK/NOT-NULL violation is a real bug and must still throw, not be
 * silently swallowed.
 */
export function createWorkflowRecord(db: Database, input: CreateWorkflowRecordInput): void {
  const now = Date.now();
  const metaJson = input.source === undefined ? null : JSON.stringify({ source: input.source });
  db.run(
    `INSERT INTO workflows
       (id, kind, repo, epic_number, adapter, state, created_at, updated_at, bunqueue_execution_id, meta_json)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    [
      input.id,
      input.kind,
      input.repo,
      input.epicNumber,
      input.adapter,
      now,
      now,
      input.id,
      metaJson,
    ],
  );
}

/** Per-pass state the checkbox-revert reconciler persists between poller ticks. */
export type CheckboxReconcileState = {
  /** The Epic PR head SHA observed at the last reconcile; null until first seen. */
  headSha: string | null;
  /** The Status checkboxes' checked-state map after the last pass (the diff base). */
  state: Record<number, boolean>;
};

/**
 * The typed shape of a workflow row's `meta_json` scratch. Every key is optional:
 * different subsystems own different keys (`source` at creation, `checkboxReconcile`
 * on the poller), so reads tolerate any subset and writes merge rather than clobber.
 */
export type WorkflowMeta = {
  source?: "manual" | "auto";
  checkboxReconcile?: CheckboxReconcileState;
};

/**
 * Parse a workflow's `meta_json` into {@link WorkflowMeta}. A null/absent/malformed
 * value reads as `{}` — the column is best-effort scratch, never load-bearing for
 * a row's existence, so an unparseable blob must not throw into a caller.
 */
export function readWorkflowMeta(db: Database, id: string): WorkflowMeta {
  const row = db.query("SELECT meta_json FROM workflows WHERE id = ?").get(id) as {
    meta_json: string | null;
  } | null;
  if (!row?.meta_json) return {};
  try {
    const parsed = JSON.parse(row.meta_json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as WorkflowMeta) : {};
  } catch {
    return {};
  }
}

/**
 * Merge `patch` into a workflow's `meta_json`, preserving keys it doesn't set
 * (read-merge-write). Single-writer-per-key in practice — `source` is written
 * once at creation, `checkboxReconcile` only by the (single-worker) poller pass —
 * so the read-modify-write needs no cross-key locking.
 *
 * Deliberately does **not** touch `updated_at`: `meta_json` is scratch, not an
 * activity signal, and the watchdog folds `updated_at` into its idle-freshness
 * baseline (see this package's CLAUDE.md). Bumping it here would let the poller's
 * checkbox-revert persist reset a running agent's idle-timeout clock — masking a
 * genuinely wedged agent (e.g. on first observation after a daemon restart).
 */
export function patchWorkflowMeta(db: Database, id: string, patch: Partial<WorkflowMeta>): void {
  const merged = { ...readWorkflowMeta(db, id), ...patch };
  db.run("UPDATE workflows SET meta_json = ? WHERE id = ?", [JSON.stringify(merged), id]);
}

/** Read a workflow's `meta_json.source` (`'manual'`/`'auto'`), or null if unset. */
export function getWorkflowSource(db: Database, id: string): "manual" | "auto" | null {
  const source = readWorkflowMeta(db, id).source;
  return source === "manual" || source === "auto" ? source : null;
}

/**
 * The checkbox-revert pass's persisted diff base for a workflow. Defaults to
 * `{ headSha: null, state: {} }` when unset, so a first observation always treats
 * the PR as advanced and every checkbox as a fresh transition.
 *
 * `readWorkflowMeta` only guards the top-level JSON shape, so the nested
 * `checkboxReconcile` is still untrusted (a hand-edited row, a forward/backward
 * version skew). This sanitizes it back to the {@link CheckboxReconcileState}
 * contract rather than trusting it — mirroring {@link getWorkflowSource}'s
 * validate-don't-trust posture: a non-object (or array) reads as the default, a
 * non-string `headSha` as null, and `state` is rebuilt keeping only boolean
 * entries (a non-object/array `state`, or any non-boolean value, is dropped).
 */
export function getCheckboxReconcileState(db: Database, id: string): CheckboxReconcileState {
  const raw = readWorkflowMeta(db, id).checkboxReconcile as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { headSha: null, state: {} };

  const candidate = raw as { headSha?: unknown; state?: unknown };
  const headSha = typeof candidate.headSha === "string" ? candidate.headSha : null;
  const rawState = candidate.state;
  const state =
    rawState && typeof rawState === "object" && !Array.isArray(rawState)
      ? (Object.fromEntries(
          Object.entries(rawState as Record<string, unknown>).filter(
            ([, value]) => typeof value === "boolean",
          ),
        ) as Record<number, boolean>)
      : {};

  return { headSha, state };
}

/** Persist the checkbox-revert pass's diff base for the next tick (merges into `meta_json`). */
export function setCheckboxReconcileState(
  db: Database,
  id: string,
  value: CheckboxReconcileState,
): void {
  patchWorkflowMeta(db, id, { checkboxReconcile: value });
}

export type WorkflowPatch = {
  state?: WorkflowState;
  worktreePath?: string;
  sessionName?: string;
  sessionToken?: string;
  sessionId?: string;
  transcriptPath?: string;
  /**
   * Who drives the session. The dashboard's Take control / Release affordances
   * flip this (`human` suspends middle's send-keys driving and the watchdog's
   * idle-kill; `middle` resumes both). The watchdog reads `controlled_by` to
   * skip freshness checks while a human is driving — see this package's CLAUDE.md.
   */
  controlledBy?: "middle" | "human";
};

const PATCH_COLUMNS: Record<keyof WorkflowPatch, string> = {
  state: "state",
  worktreePath: "worktree_path",
  sessionName: "session_name",
  sessionToken: "session_token",
  sessionId: "session_id",
  transcriptPath: "transcript_path",
  controlledBy: "controlled_by",
};

/**
 * An observer notified after every {@link updateWorkflow} write. Observers fan
 * out from one write: the daemon registers one to broadcast middle's DB-only
 * state transitions (`launching`, `waiting-human`, `rate-limited`, `compensated`)
 * that bunqueue's engine never emits onto `/control/events` (see `main.ts`), and
 * the dashboard registers
 * one to nudge the affected repo's SSE channel so its views refresh live (see
 * `bridgeWorkflowsToBus`). Observers are module-level (process-scoped); each
 * registration returns its own disposer, and the daemon clears all on shutdown.
 */
export type UpdateWorkflowObserver = (id: string, patch: WorkflowPatch) => void;

const updateObservers = new Set<UpdateWorkflowObserver>();

/**
 * Register an {@link UpdateWorkflowObserver} and return a disposer that removes
 * only THAT observer. Observers fan out — the daemon's control-feed broadcaster
 * and the dashboard's repo-channel nudge coexist. The disposer is idempotent:
 * calling it more than once is safe (removing an absent observer is a no-op).
 */
export function addWorkflowObserver(observer: UpdateWorkflowObserver): () => void {
  updateObservers.add(observer);
  return () => {
    updateObservers.delete(observer);
  };
}

/** Remove every registered observer (daemon shutdown / test reset). */
export function clearWorkflowObservers(): void {
  updateObservers.clear();
}

/**
 * Notify every observer of a write, never letting one break the durable write
 * path or the others. Each observer runs inside its own try/catch — a throw from
 * one is logged and the remaining observers still fire.
 */
function notifyUpdateObservers(id: string, patch: WorkflowPatch): void {
  for (const observer of updateObservers) {
    try {
      observer(id, patch);
    } catch (error) {
      console.error(`[workflow-record] update observer threw: ${(error as Error).message}`);
    }
  }
}

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
  notifyUpdateObservers(id, patch);
}

/**
 * Conditionally finalize a parked workflow: write `finalState` **only if the row
 * is still `waiting-human`**, returning whether it actually transitioned. Guards
 * the reconciler against the race where another path (a resume signal firing)
 * advances the row between the reconciler's parked-row scan and its write — an
 * unconditional `updateWorkflow` would clobber the newer state. Fires the update
 * observer (the SSE broadcast) only on a real transition, so the page reflects
 * exactly the rows that were finalized.
 */
export function finalizeParkedWorkflow(
  db: Database,
  id: string,
  finalState: TerminalWorkflowState,
): boolean {
  const res = db.run(
    "UPDATE workflows SET state = ?, updated_at = ? WHERE id = ? AND state = 'waiting-human'",
    [finalState, Date.now(), id],
  );
  const changed = (res.changes ?? 0) > 0;
  if (changed) notifyUpdateObservers(id, { state: finalState });
  return changed;
}

/**
 * The terminal states. A workflow in one of these no longer owns its session,
 * so its hooks are stale and must not be correlated to it — `session.started`
 * for a *new* dispatch reusing a deterministic session name would otherwise
 * attach to the corpse.
 */
const TERMINAL_STATES = [
  "completed",
  "compensated",
  "failed",
  "cancelled",
] as const satisfies readonly TerminalWorkflowState[];

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
    .get(sessionName, ...TERMINAL_STATES) as { id: string; session_token: string | null } | null;
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

/** Timestamp of the most recent `events` row of this type for the workflow, or null. */
export function lastEventTs(db: Database, workflowId: string, type: string): number | null {
  const row = db
    .query("SELECT ts FROM events WHERE workflow_id = ? AND type = ? ORDER BY ts DESC LIMIT 1")
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

/** A parked workflow the poller is watching: its armed wait joined to repo/epic. */
export type PollableWait = {
  workflowId: string;
  repo: string;
  epicNumber: number | null;
  signalName: string;
  createdAt: number;
  firedAt: number | null;
};

/**
 * Every armed wait on a parked (`waiting-human`) workflow, joined to its
 * repo/epic — the poller's working set. Already-fired waits are included so the
 * poller can decide idempotently; the poller filters on `firedAt`.
 */
export function loadPollableWaits(db: Database): PollableWait[] {
  return db
    .query(
      `SELECT s.workflow_id, s.signal_name, s.created_at, s.fired_at,
              w.repo, w.epic_number
         FROM waitfor_signals s
         JOIN workflows w ON w.id = s.workflow_id
        WHERE w.state = 'waiting-human'`,
    )
    .all()
    .map((r) => {
      const row = r as {
        workflow_id: string;
        signal_name: string;
        created_at: number;
        fired_at: number | null;
        repo: string;
        epic_number: number | null;
      };
      return {
        workflowId: row.workflow_id,
        repo: row.repo,
        epicNumber: row.epic_number,
        signalName: row.signal_name,
        createdAt: row.created_at,
        firedAt: row.fired_at,
      };
    });
}

/** Mark a workflow's armed wait as fired so the poller won't re-fire it. */
export function markSignalFired(db: Database, workflowId: string, ts: number = Date.now()): void {
  db.run("UPDATE waitfor_signals SET fired_at = ? WHERE workflow_id = ?", [ts, workflowId]);
}

/**
 * The signal armed for this workflow, or null. The poller reads this to learn
 * what an Epic is waiting on (the epic-scoped, reason-scoped `signal_name`)
 * without consuming it; only a successful resume consumes the row.
 */
export function getWaitForSignal(db: Database, workflowId: string): ArmedSignal | null {
  const row = db
    .query("SELECT signal_name, payload_json FROM waitfor_signals WHERE workflow_id = ? LIMIT 1")
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
  epic_ref: string | null;
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

/** Live implementation-slot usage: total + per-adapter counts. */
export type SlotUsageCounts = {
  total: number;
  perAdapter: Record<string, number>;
};

/**
 * Count the non-terminal `kind = "implementation"` workflows that are occupying
 * a dispatch slot, total and grouped by adapter. The recommender's own row
 * (`kind = "recommender"`) is deliberately excluded — it runs on its own
 * dedicated slot and is never counted against `maxConcurrent` (build spec →
 * "recommender workflow": "not counted against maxConcurrent"). This is the
 * `slots.used` the recommender's build-prompt injects verbatim.
 *
 * `repo` scopes the count to one repo's slots (per-repo `slots.used` / `total`);
 * omit it for the cross-repo `global_used`. The dispatcher's db is shared across
 * repos (one `db_path`), so the repo filter matters — without it, repo A's
 * recommender would count repo B's agents against repo A's per-repo `max`.
 */
export function countActiveImplementationSlots(db: Database, repo?: string): SlotUsageCounts {
  const placeholders = TERMINAL_STATES.map(() => "?").join(", ");
  const repoClause = repo === undefined ? "" : " AND repo = ?";
  const params = repo === undefined ? TERMINAL_STATES : [...TERMINAL_STATES, repo];
  const rows = db
    .query(
      `SELECT adapter, count(*) AS n FROM workflows
        WHERE kind = 'implementation' AND state NOT IN (${placeholders})${repoClause}
        GROUP BY adapter`,
    )
    .all(...params) as { adapter: string; n: number }[];
  const perAdapter: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    perAdapter[row.adapter] = row.n;
    total += row.n;
  }
  return { total, perAdapter };
}

/** A live implementation workflow, as the recommender's `in_flight` reports it. */
export type ActiveImplementationWorkflow = {
  epicNumber: number | null;
  adapter: string;
  sessionName: string | null;
  state: WorkflowState;
};

/**
 * The non-terminal `kind = "implementation"` workflows — the dispatcher's
 * authoritative in-flight set the recommender consumes verbatim (it never
 * recomputes them). The recommender's own row is excluded by the `kind` filter.
 * `repo` scopes the list to one repo (the shared db spans repos); omit it for all.
 */
export function listActiveImplementationWorkflows(
  db: Database,
  repo?: string,
): ActiveImplementationWorkflow[] {
  const placeholders = TERMINAL_STATES.map(() => "?").join(", ");
  const repoClause = repo === undefined ? "" : " AND repo = ?";
  const params = repo === undefined ? TERMINAL_STATES : [...TERMINAL_STATES, repo];
  const rows = db
    .query(
      `SELECT epic_number, adapter, session_name, state FROM workflows
        WHERE kind = 'implementation' AND state NOT IN (${placeholders})${repoClause}
        ORDER BY created_at ASC, rowid ASC`,
    )
    .all(...params) as {
    epic_number: number | null;
    adapter: string;
    session_name: string | null;
    state: string;
  }[];
  return rows.map((r) => ({
    epicNumber: r.epic_number,
    adapter: r.adapter,
    sessionName: r.session_name,
    state: r.state as WorkflowState,
  }));
}

/**
 * Whether an `implementation` Epic already has a non-terminal workflow row — the
 * `/control/dispatch` 409 collision guard. A second concurrent run of the same
 * Epic would clash on the deterministic tmux session + worktree path, so it's
 * rejected. Scoped to `kind = 'implementation'`: the recommender's own row never
 * claims a dispatch slot.
 */
export function hasNonTerminalEpicWorkflow(
  db: Database,
  repo: string,
  epicNumber: number,
): boolean {
  const placeholders = TERMINAL_STATES.map(() => "?").join(", ");
  const row = db
    .query(
      `SELECT 1 AS n FROM workflows
        WHERE kind = 'implementation' AND repo = ? AND epic_number = ?
          AND state NOT IN (${placeholders})
        LIMIT 1`,
    )
    .get(repo, epicNumber, ...TERMINAL_STATES) as { n: number } | null;
  return row !== null;
}

/** A non-terminal workflow as the control-plane init-replay reports it. */
export type NonTerminalWorkflow = {
  id: string;
  repo: string;
  epicNumber: number | null;
  state: WorkflowState;
};

/**
 * The non-terminal `kind = 'implementation'` workflows — the init-replay set a
 * fresh `/control/events` subscriber receives so it catches up to current state
 * (a still-running dispatch, a parked review). Excludes the recommender's row.
 */
export function listNonTerminalWorkflows(db: Database): NonTerminalWorkflow[] {
  const placeholders = TERMINAL_STATES.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT id, repo, epic_number, state FROM workflows
        WHERE kind = 'implementation' AND state NOT IN (${placeholders})
        ORDER BY created_at ASC, rowid ASC`,
    )
    .all(...TERMINAL_STATES) as {
    id: string;
    repo: string;
    epic_number: number | null;
    state: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    repo: r.repo,
    epicNumber: r.epic_number,
    state: r.state as WorkflowState,
  }));
}

/** A parked `implementation` workflow the reconciler considers, with its worktree. */
export type ParkedWorkflow = {
  id: string;
  repo: string;
  epicNumber: number;
  worktreePath: string | null;
};

/**
 * Parked `kind = 'implementation'` workflows (`state = 'waiting-human'`) that own
 * an Epic — the set the merged/closed-PR reconciler walks. Rows with a null
 * `epic_number` are excluded: with no Epic there's no PR lifecycle to consult.
 * Ordered oldest-first so the burst cap reconciles the longest-stuck rows first.
 */
export function listParkedImplementationWorkflows(db: Database): ParkedWorkflow[] {
  const rows = db
    .query(
      `SELECT id, repo, epic_number, worktree_path FROM workflows
        WHERE kind = 'implementation' AND state = 'waiting-human' AND epic_number IS NOT NULL
        ORDER BY created_at ASC, rowid ASC`,
    )
    .all() as {
    id: string;
    repo: string;
    epic_number: number;
    worktree_path: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    repo: r.repo,
    epicNumber: r.epic_number,
    worktreePath: r.worktree_path,
  }));
}

/** A running `implementation` workflow the checkbox-revert pass considers. */
export type RunningWorkflow = {
  id: string;
  repo: string;
  epicNumber: number;
  worktreePath: string;
};

/**
 * Running `kind = 'implementation'` workflows that own both an Epic and a worktree
 * — the set the checkbox-revert pass walks after a push. An Epic is required to
 * find the PR; a worktree is required to run the gates, so rows missing either are
 * excluded (the pass would have nothing to act on). Ordered oldest-first so the
 * burst cap services the longest-running rows first.
 */
export function listRunningImplementationWorkflows(db: Database): RunningWorkflow[] {
  const rows = db
    .query(
      `SELECT id, repo, epic_number, worktree_path FROM workflows
        WHERE kind = 'implementation' AND state = 'running'
          AND epic_number IS NOT NULL AND worktree_path IS NOT NULL
        ORDER BY created_at ASC, rowid ASC`,
    )
    .all() as {
    id: string;
    repo: string;
    epic_number: number;
    worktree_path: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    repo: r.repo,
    epicNumber: r.epic_number,
    worktreePath: r.worktree_path,
  }));
}

/** Fetch a workflow row by id, or null if it does not exist. */
export function getWorkflow(db: Database, id: string): WorkflowRecord | null {
  const row = db.query("SELECT * FROM workflows WHERE id = ?").get(id) as WorkflowRow | null;
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind as WorkflowRecord["kind"],
    repo: row.repo,
    epicNumber: row.epic_number,
    epicRef: row.epic_ref,
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
