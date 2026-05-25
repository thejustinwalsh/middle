import type { Database } from "bun:sqlite";

/**
 * Per-repo dispatcher state in the `repo_config` table. v1 uses only the
 * `paused_until` column — the pause/resume control surface (`mm pause` /
 * `mm resume`). A non-null `paused_until` in the future means auto-dispatch is
 * suspended for that repo (build spec → "SQLite schema": "if non-null, no
 * auto-dispatch"). The other columns (`config_json`, the recommender bookkeeping)
 * are reserved for later sync work; the row is created lazily on first pause with
 * an empty `config_json` placeholder.
 *
 * Source of truth: build spec → "SQLite schema" (`repo_config`), "CLI reference"
 * (`mm pause`/`mm resume`), and "Auto-dispatch loop".
 */

/** A pause that never auto-expires — `mm pause` with no duration suspends indefinitely. */
const INDEFINITE_PAUSE = Number.MAX_SAFE_INTEGER;

/**
 * Set a repo's `paused_until`. Upserts the `repo_config` row, creating it with an
 * empty `config_json` placeholder if absent (only `paused_until` + the sync
 * timestamp are touched on conflict, so a later config sync isn't clobbered).
 * `until` is unix-ms; omit it to pause indefinitely (`mm pause`).
 */
export function setPausedUntil(
  db: Database,
  repo: string,
  until: number = INDEFINITE_PAUSE,
  now: number = Date.now(),
): void {
  db.run(
    `INSERT INTO repo_config (repo, config_json, paused_until, last_synced_at)
       VALUES (?, '{}', ?, ?)
     ON CONFLICT(repo) DO UPDATE SET paused_until = excluded.paused_until,
       last_synced_at = excluded.last_synced_at`,
    [repo, until, now],
  );
}

/** Clear a repo's pause (`mm resume`). A no-op if the repo has no row. */
export function clearPaused(db: Database, repo: string, now: number = Date.now()): void {
  db.run(`UPDATE repo_config SET paused_until = NULL, last_synced_at = ? WHERE repo = ?`, [
    now,
    repo,
  ]);
}

/** A repo's `paused_until` (unix-ms), or null if unpaused / no row. */
export function getPausedUntil(db: Database, repo: string): number | null {
  const row = db.query("SELECT paused_until FROM repo_config WHERE repo = ?").get(repo) as {
    paused_until: number | null;
  } | null;
  return row?.paused_until ?? null;
}

/**
 * Whether a repo is paused right now: `paused_until` is set and still in the
 * future. A pause whose timestamp has elapsed auto-expires (reads as unpaused),
 * so a bounded pause needs no separate cleanup.
 */
export function isPaused(db: Database, repo: string, now: number = Date.now()): boolean {
  const until = getPausedUntil(db, repo);
  return until !== null && until > now;
}
