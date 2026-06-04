/**
 * The queue-observability tab — the ported successor to the dispatcher's old
 * status page. Renders the aggregate gauges and the in-flight/parked workflows
 * from `/control/metrics`, refreshed live by `/control/events` frames (passed in
 * by `App`). Read-only; React's default escaping replaces the old page's manual
 * `textContent` discipline.
 */
import type { ControlMetrics, ControlWorkflowFrame } from "../control-client.ts";
import { Badge, type BadgeProps } from "./ui/badge.tsx";

/**
 * Map a workflow state to a Badge intent. `waiting`/`compensating` stay neutral
 * (outline) — deliberately uncolored, mirroring the old status-page behavior.
 */
function stateVariant(state: string): BadgeProps["variant"] {
  if (state === "running" || state === "completed") return "success";
  if (state === "launching" || state === "pending") return "default";
  if (state === "waiting-human") return "warning";
  if (
    state === "rate-limited" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "compensated"
  )
    return "destructive";
  return "outline";
}

type QueueProps = {
  /** Latest `/control/metrics` snapshot, or null before the first fetch. */
  metrics: ControlMetrics | null;
  /** Live workflow frames (most-recent state per id), parked-for-human first. */
  live: ControlWorkflowFrame[];
};

/** Parked-waiting-on-human rows sort to the top — they're what needs attention. */
function sortLive(rows: ControlWorkflowFrame[]): ControlWorkflowFrame[] {
  return [...rows].sort((a, b) => {
    if (a.state === "waiting-human" && b.state !== "waiting-human") return -1;
    if (b.state === "waiting-human" && a.state !== "waiting-human") return 1;
    return 0;
  });
}

/**
 * Render the queue-observability view: gauge tiles + the in-flight/parked table
 * (waiting-human first) from a `/control/metrics` snapshot, plus the rate-limit
 * chips. `metrics === null` renders the pre-fetch "no data yet" placeholder.
 * `live` is the latest frame per workflow id (terminal ones already dropped by
 * the caller); it drives the table, while `metrics.totals` drives the tiles.
 */
export function Queue({ metrics, live }: QueueProps) {
  if (!metrics)
    return (
      <main className="queue">
        <p className="empty">no data yet</p>
      </main>
    );
  const rows = sortLive(live);
  return (
    <main className="queue">
      <section className="tiles">
        <div className="tile">
          <div className="n">{metrics.totals.active}</div>
          <div className="l">Active</div>
        </div>
        <div className="tile">
          <div className="n">{metrics.totals.waitingHuman}</div>
          <div className="l">Waiting for you</div>
        </div>
        <div className="tile">
          <div className="n">{metrics.totals.all}</div>
          <div className="l">Total workflows</div>
        </div>
      </section>
      <h2>In flight &amp; parked</h2>
      <table className="active">
        <thead>
          <tr>
            <th>repo</th>
            <th>epic</th>
            <th>state</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={3} className="empty">
                nothing in flight
              </td>
            </tr>
          ) : (
            rows.map((w) => (
              <tr key={w.id}>
                <td>{w.repo || "—"}</td>
                <td>{w.epic === null ? "—" : `#${w.epic}`}</td>
                <td className="state">
                  <Badge variant={stateVariant(w.state)} className={`s-${w.state}`}>
                    {w.state}
                  </Badge>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <h2>Rate limits</h2>
      <div className="chips flex flex-wrap gap-2">
        {metrics.rateLimits.length === 0 ? (
          <span className="empty">no rate-limit data</span>
        ) : (
          metrics.rateLimits.map((r) => (
            <Badge
              key={r.adapter}
              variant={
                r.status === "AVAILABLE"
                  ? "success"
                  : r.status === "RATE_LIMITED"
                    ? "destructive"
                    : "outline"
              }
              className={`c-${r.status.toLowerCase()}`}
            >
              {r.adapter}: {r.status}
            </Badge>
          ))
        )}
      </div>
    </main>
  );
}
