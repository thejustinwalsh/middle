import type { Database } from "bun:sqlite";

/**
 * Reactive rate-limit state, per the spec's constraint — no undocumented
 * endpoints, no proactive probing. State is written when a `Stop` boundary's
 * transcript/payload reveals a usage-limit message, and reverted to available
 * by the next successful dispatch (probe-via-real-work).
 *
 * Source of truth: build spec → "Rate-limit detection (reactive, per the
 * constraint)" and "SQLite schema" (`rate_limit_state`).
 */

export type RateLimitStatus = "AVAILABLE" | "RATE_LIMITED" | "UNKNOWN";

export type RateLimitState = {
  adapter: string;
  status: RateLimitStatus;
  resetAt: number | null;
  observedAt: number;
  source: string | null;
  detail: string | null;
};

type RateLimitRow = {
  adapter: string;
  status: string;
  reset_at: number | null;
  observed_at: number;
  source: string | null;
  detail: string | null;
};

/** Current rate-limit state for an adapter, or null if never observed. */
export function getRateLimitState(db: Database, adapter: string): RateLimitState | null {
  const row = db.query("SELECT * FROM rate_limit_state WHERE adapter = ?").get(adapter) as
    | RateLimitRow
    | null;
  if (!row) return null;
  return {
    adapter: row.adapter,
    status: row.status as RateLimitStatus,
    resetAt: row.reset_at,
    observedAt: row.observed_at,
    source: row.source,
    detail: row.detail,
  };
}

export type SetRateLimitedInput = {
  adapter: string;
  resetAt: number | null;
  source: string;
  detail?: string | null;
  now?: number;
};

/** Upsert an adapter to `RATE_LIMITED` with its reset time + provenance. */
export function setRateLimited(db: Database, input: SetRateLimitedInput): void {
  const now = input.now ?? Date.now();
  db.run(
    `INSERT INTO rate_limit_state (adapter, status, reset_at, observed_at, source, detail)
       VALUES (?, 'RATE_LIMITED', ?, ?, ?, ?)
     ON CONFLICT(adapter) DO UPDATE SET
       status = 'RATE_LIMITED', reset_at = excluded.reset_at,
       observed_at = excluded.observed_at, source = excluded.source, detail = excluded.detail`,
    [input.adapter, input.resetAt, now, input.source, input.detail ?? null],
  );
}

/** Upsert an adapter to `AVAILABLE`, clearing its reset time. */
export function markAvailable(db: Database, adapter: string, now: number = Date.now()): void {
  db.run(
    `INSERT INTO rate_limit_state (adapter, status, reset_at, observed_at, source, detail)
       VALUES (?, 'AVAILABLE', NULL, ?, ?, NULL)
     ON CONFLICT(adapter) DO UPDATE SET
       status = 'AVAILABLE', reset_at = NULL, observed_at = excluded.observed_at,
       source = excluded.source, detail = NULL`,
    [adapter, now, "probe-via-real-work"],
  );
}

/**
 * The probe-via-real-work revert: a dispatch that actually completed proves the
 * adapter is serving again, so flip `RATE_LIMITED` → `AVAILABLE`. A no-op unless
 * the adapter was rate-limited, so a normal completion never thrashes the row.
 * Returns whether it flipped.
 */
export function markAvailableOnSuccess(
  db: Database,
  adapter: string,
  now: number = Date.now(),
): boolean {
  const current = getRateLimitState(db, adapter);
  if (current?.status !== "RATE_LIMITED") return false;
  markAvailable(db, adapter, now);
  return true;
}

/**
 * Parse the reset time captured from a usage-limit message into unix ms. The
 * captured text is whatever followed "Resets at " up to the period; an ISO
 * timestamp parses, anything unrecognized yields null (RATE_LIMITED with an
 * unknown reset, which the auto-dispatch loop treats conservatively).
 */
export function parseResetAt(raw: string): number | null {
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}
