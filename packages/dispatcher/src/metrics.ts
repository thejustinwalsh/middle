import type { Database } from "bun:sqlite";
import { countActiveImplementationSlots, type SlotUsageCounts } from "./workflow-record.ts";

/**
 * One `(repo, kind, state)` bucket of the `workflows` table. The cross-product
 * of every repo middle manages, the workflow kind (`implementation` /
 * `recommender`), and the lifecycle state — the raw shape the observability
 * surfaces (`/metrics`, `/control/metrics`, the status page) aggregate from.
 */
export type WorkflowStateCount = {
  repo: string;
  kind: string;
  state: string;
  count: number;
};

/** A single adapter's current rate-limit standing, flattened for export. */
export type RateLimitMetric = {
  adapter: string;
  status: string;
  resetAt: number | null;
};

/**
 * A point-in-time snapshot of the dispatcher's queue/engine state, computed
 * purely from the shared SQLite db — no daemon runtime needed, so it's
 * unit-testable and the same value backs both the Prometheus text export and
 * the JSON the status page consumes. This is engine *observability* (what's in
 * flight, what's parked, what's rate-limited), distinct from the task-management
 * dashboard (#54); when that lands this snapshot folds into it.
 */
export type MetricsSnapshot = {
  /** Epoch ms the snapshot was taken — the page shows it as "last updated". */
  generatedAt: number;
  /** Every `(repo, kind, state)` bucket, ordered for stable rendering. */
  workflows: WorkflowStateCount[];
  /** Non-terminal implementation workflows holding a dispatch slot. */
  slots: SlotUsageCounts;
  /** Rate-limit standing for every adapter that has ever been observed. */
  rateLimits: RateLimitMetric[];
  /** Roll-ups the page reads directly: total rows, active (slot-holding), parked-for-human. */
  totals: { all: number; active: number; waitingHuman: number };
};

/** Read the dispatcher's current queue/engine state from the shared db. */
export function collectMetrics(db: Database, now: number = Date.now()): MetricsSnapshot {
  const workflows = db
    .query(
      `SELECT repo, kind, state, count(*) AS count FROM workflows
        GROUP BY repo, kind, state
        ORDER BY repo ASC, kind ASC, state ASC`,
    )
    .all() as WorkflowStateCount[];
  const slots = countActiveImplementationSlots(db);
  const rateLimits = db
    .query(`SELECT adapter, status, reset_at AS resetAt FROM rate_limit_state ORDER BY adapter ASC`)
    .all() as RateLimitMetric[];

  let all = 0;
  let waitingHuman = 0;
  for (const w of workflows) {
    all += w.count;
    if (w.state === "waiting-human") waitingHuman += w.count;
  }
  return {
    generatedAt: now,
    workflows,
    slots,
    rateLimits,
    totals: { all, active: slots.total, waitingHuman },
  };
}

/** Escape a Prometheus label value (`\`, `"`, and newlines per the exposition format). */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Render a {@link MetricsSnapshot} as Prometheus text-exposition format so any
 * scraper (Prometheus, Grafana Agent, …) can read the daemon at `GET /metrics`.
 * Every series is a gauge — these are instantaneous counts, not monotonic
 * counters. The metrics describe middle's *own* domain (workflows by repo/state,
 * slots, rate-limit standing), not bunqueue's queue internals (our embedded
 * engine doesn't drive bunqueue's instrumented queue ops, so those would read
 * zero); this reflects what an operator actually watches.
 */
export function renderPrometheus(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];

  lines.push("# HELP middle_workflows Workflows grouped by repo, kind, and lifecycle state.");
  lines.push("# TYPE middle_workflows gauge");
  for (const w of snapshot.workflows) {
    const labels = `repo="${escapeLabel(w.repo)}",kind="${escapeLabel(w.kind)}",state="${escapeLabel(w.state)}"`;
    lines.push(`middle_workflows{${labels}} ${w.count}`);
  }

  lines.push(
    "# HELP middle_slots_active Non-terminal implementation workflows holding a dispatch slot.",
  );
  lines.push("# TYPE middle_slots_active gauge");
  for (const [adapter, n] of Object.entries(snapshot.slots.perAdapter)) {
    lines.push(`middle_slots_active{adapter="${escapeLabel(adapter)}"} ${n}`);
  }
  lines.push(`middle_slots_active_total ${snapshot.slots.total}`);

  lines.push(
    "# HELP middle_rate_limited Whether an adapter is currently rate-limited (1) or not (0).",
  );
  lines.push("# TYPE middle_rate_limited gauge");
  for (const rl of snapshot.rateLimits) {
    const limited = rl.status === "RATE_LIMITED" ? 1 : 0;
    lines.push(`middle_rate_limited{adapter="${escapeLabel(rl.adapter)}"} ${limited}`);
  }

  lines.push("# HELP middle_workflows_total Total workflow rows across all states.");
  lines.push("# TYPE middle_workflows_total gauge");
  lines.push(`middle_workflows_total ${snapshot.totals.all}`);

  lines.push("# HELP middle_workflows_waiting_human Workflows parked waiting for a human.");
  lines.push("# TYPE middle_workflows_waiting_human gauge");
  lines.push(`middle_workflows_waiting_human ${snapshot.totals.waitingHuman}`);

  // Trailing newline — the exposition format wants the body to end with one.
  return lines.join("\n") + "\n";
}
