import type { Database } from "bun:sqlite";

/**
 * Delete `events` rows older than this. The spec's retention window: operational
 * activity is a 14-day rolling log, not a permanent record (GitHub is the system
 * of record). Indexed by `idx_events_ts` so the scan is cheap.
 */
export const EVENTS_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Archive `completed` workflows older than this (by `updated_at` — the time the
 * row reached its terminal state). Archival drops the workflow's events but
 * preserves the row (final state + `meta_json` config snapshot), so history
 * stays auditable while the events table stays bounded.
 */
export const WORKFLOWS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Daily cadence for the retention cron — retention is not latency-sensitive. */
export const RETENTION_CRON_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** What one retention pass pruned/archived. */
export type RetentionResult = { eventsDeleted: number; workflowsArchived: number };

/** A recorded retention pass, as `mm doctor` reads it back. */
export type RetentionRun = {
  id: number;
  ranAt: number;
  eventsDeleted: number;
  workflowsArchived: number;
  ok: boolean;
  detail: string | null;
};

/** Row counts + last-run status — the shape `mm doctor` reports. */
export type RetentionStatus = {
  rowCounts: { workflows: number; archivedWorkflows: number; events: number };
  lastRun: RetentionRun | null;
};

/** Overridable knobs; `now` and the cutoffs are injected so tests pin them. */
export type RetentionOptions = {
  now?: number;
  eventsMaxAgeMs?: number;
  workflowsMaxAgeMs?: number;
};

/**
 * Record one retention pass in `retention_runs`. Called by {@link runRetentionPass}
 * on both success (`ok=true`) and failure (`ok=false`, with `detail`), so
 * `mm doctor` can surface a recent failure rather than silently showing the last
 * good run. Best-effort: a write that itself throws is swallowed (the pass error
 * is the one that matters), so this never masks the original failure.
 */
export function recordRetentionRun(
  db: Database,
  run: { ranAt: number; eventsDeleted: number; workflowsArchived: number; detail?: string | null },
): void {
  try {
    db.run(
      `INSERT INTO retention_runs (ran_at, events_deleted, workflows_archived, ok, detail)
       VALUES (?, ?, ?, ?, ?)`,
      [run.ranAt, run.eventsDeleted, run.workflowsArchived, run.detail ? 0 : 1, run.detail ?? null],
    );
  } catch (error) {
    console.error(`[retention] failed to record run: ${(error as Error).message}`);
  }
}

/** The most recent retention pass, or null if retention has never run. */
export function getLatestRetentionRun(db: Database): RetentionRun | null {
  const row = db
    .query(
      `SELECT id, ran_at AS ranAt, events_deleted AS eventsDeleted,
              workflows_archived AS workflowsArchived, ok, detail
         FROM retention_runs ORDER BY ran_at DESC, id DESC LIMIT 1`,
    )
    .get() as (Omit<RetentionRun, "ok"> & { ok: number }) | null;
  if (!row) return null;
  return { ...row, ok: row.ok === 1 };
}

/** Row counts + last retention run — what `mm doctor` reports for the db. */
export function collectRetentionStatus(db: Database): RetentionStatus {
  const workflows = (db.query("SELECT count(*) AS c FROM workflows").get() as { c: number }).c;
  const archivedWorkflows = (
    db.query("SELECT count(*) AS c FROM workflows WHERE archived_at IS NOT NULL").get() as {
      c: number;
    }
  ).c;
  const events = (db.query("SELECT count(*) AS c FROM events").get() as { c: number }).c;
  return {
    rowCounts: { workflows, archivedWorkflows, events },
    lastRun: getLatestRetentionRun(db),
  };
}

/**
 * Run one retention pass against middle's SQLite — and **only** SQLite; GitHub
 * is the system of record and is never touched. Two cutoffs, both relative to
 * `now`:
 *
 * 1. Delete every `events` row older than `eventsMaxAgeMs` (default 14d).
 * 2. Archive every `completed` workflow whose `updated_at` is older than
 *    `workflowsMaxAgeMs` (default 30d) and that isn't already archived: drop its
 *    events and stamp `archived_at`. The row, its final state, and its
 *    `meta_json` config snapshot are preserved. `archived_at IS NULL` in the
 *    predicate makes the pass idempotent — re-running archives nothing new.
 *
 * The mutations run in one transaction. The run is recorded in `retention_runs`
 * either way: on success with `ok=1`, on failure with `ok=0` and the error
 * detail (then the error is rethrown for the cron to log).
 */
export function runRetentionPass(db: Database, opts: RetentionOptions = {}): RetentionResult {
  const now = opts.now ?? Date.now();
  const eventsCutoff = now - (opts.eventsMaxAgeMs ?? EVENTS_MAX_AGE_MS);
  const workflowsCutoff = now - (opts.workflowsMaxAgeMs ?? WORKFLOWS_MAX_AGE_MS);

  try {
    const result = db.transaction(() => {
      const eventsDeleted = db.run("DELETE FROM events WHERE ts < ?", [eventsCutoff]).changes;
      // Drop events of the workflows about to be archived, then stamp them. Both
      // statements share the same predicate so the counts stay consistent.
      const archivePredicate = "state = 'completed' AND updated_at < ? AND archived_at IS NULL";
      db.run(
        `DELETE FROM events WHERE workflow_id IN (SELECT id FROM workflows WHERE ${archivePredicate})`,
        [workflowsCutoff],
      );
      const workflowsArchived = db.run(
        `UPDATE workflows SET archived_at = ? WHERE ${archivePredicate}`,
        [now, workflowsCutoff],
      ).changes;
      return { eventsDeleted, workflowsArchived };
    })();
    recordRetentionRun(db, { ranAt: now, ...result });
    return result;
  } catch (error) {
    recordRetentionRun(db, {
      ranAt: now,
      eventsDeleted: 0,
      workflowsArchived: 0,
      detail: (error as Error).message,
    });
    throw error;
  }
}
