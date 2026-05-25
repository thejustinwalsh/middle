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

/** A repo middle manages: its slug + the local checkout the daemon/cron operate on. */
export type ManagedRepo = { repo: string; checkoutPath: string };

/**
 * Record (or update) a repo's local checkout path — the act that makes a repo
 * "managed": it becomes visible to the recommender cron and survives a daemon
 * restart. Upserts the `repo_config` row (empty `config_json` placeholder if
 * absent), touching only `checkout_path` + the sync timestamp on conflict so a
 * pause / recommender bookkeeping isn't clobbered. Written by `mm init` and by
 * the daemon whenever it learns a path (dispatch / recommender trigger).
 */
export function registerManagedRepo(
  db: Database,
  repo: string,
  checkoutPath: string,
  now: number = Date.now(),
): void {
  db.run(
    `INSERT INTO repo_config (repo, config_json, checkout_path, last_synced_at)
       VALUES (?, '{}', ?, ?)
     ON CONFLICT(repo) DO UPDATE SET checkout_path = excluded.checkout_path,
       last_synced_at = excluded.last_synced_at`,
    [repo, checkoutPath, now],
  );
}

/** A repo's registered checkout path, or null if it has no row / no path yet. */
export function getManagedRepoPath(db: Database, repo: string): string | null {
  const row = db.query("SELECT checkout_path FROM repo_config WHERE repo = ?").get(repo) as {
    checkout_path: string | null;
  } | null;
  return row?.checkout_path ?? null;
}

/**
 * Every managed repo — the rows with a non-null `checkout_path`. The recommender
 * cron iterates this; the daemon hydrates its in-memory path map from it on
 * startup. Ordered by slug for stable iteration.
 */
export function listManagedRepos(db: Database): ManagedRepo[] {
  const rows = db
    .query(
      "SELECT repo, checkout_path FROM repo_config WHERE checkout_path IS NOT NULL ORDER BY repo ASC",
    )
    .all() as { repo: string; checkout_path: string }[];
  return rows.map((r) => ({ repo: r.repo, checkoutPath: r.checkout_path }));
}

/** When the recommender last ran for a repo (unix-ms), or null if never. */
export function getLastRecommenderRun(db: Database, repo: string): number | null {
  const row = db.query("SELECT last_recommender_run FROM repo_config WHERE repo = ?").get(repo) as {
    last_recommender_run: number | null;
  } | null;
  return row?.last_recommender_run ?? null;
}

/**
 * Stamp a repo's `last_recommender_run`. The cron sets it **before** firing a
 * run so an overlapping tick can't double-dispatch the same repo (the due-check
 * reads this). Upserts like {@link registerManagedRepo}.
 */
export function markRecommenderRun(db: Database, repo: string, now: number = Date.now()): void {
  db.run(
    `INSERT INTO repo_config (repo, config_json, last_recommender_run, last_synced_at)
       VALUES (?, '{}', ?, ?)
     ON CONFLICT(repo) DO UPDATE SET last_recommender_run = excluded.last_recommender_run,
       last_synced_at = excluded.last_synced_at`,
    [repo, now, now],
  );
}
