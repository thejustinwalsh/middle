/**
 * Small display formatters shared by the views. Pure functions — unit-tested
 * directly, and safe to call during static render.
 */

/** A compact "time ago" for heartbeats/timestamps: `14s`, `18m`, `2h`, `3d`. `null` → `—`. */
export function ago(ts: number | null, now: number = Date.now()): string {
  if (ts === null) return "—";
  const secs = Math.max(0, Math.floor((now - ts) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** A rate-limit status as a glyph + label: `✓ available`, `⏸ rate limited`, `? unknown`. */
export function rateLimitLabel(status: "AVAILABLE" | "RATE_LIMITED" | "UNKNOWN"): string {
  switch (status) {
    case "AVAILABLE":
      return "✓ available";
    case "RATE_LIMITED":
      return "⏸ rate limited";
    default:
      return "? unknown";
  }
}

/** The countdown to a reset time as `2h 14m`, or empty when null/elapsed. */
export function untilReset(resetAt: number | null, now: number = Date.now()): string {
  if (resetAt === null || resetAt <= now) return "";
  const mins = Math.floor((resetAt - now) / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
