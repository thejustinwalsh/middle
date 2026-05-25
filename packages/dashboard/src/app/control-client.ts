/**
 * Client for the dispatcher's control plane (`/control/metrics`, `/control/events`)
 * — the engine-observability surface the Queue tab renders. Distinct from the
 * dashboard's own `/api/*` + `/events/*`; same origin/port (the daemon serves both).
 */

/** A live workflow-transition frame from `/control/events` (named event `workflow`). */
export type ControlWorkflowFrame = { id: string; repo: string; epic: number | null; state: string };

/** One `(repo, kind, state)` bucket from `/control/metrics`. */
export type WorkflowStateCount = { repo: string; kind: string; state: string; count: number };

/** The `/control/metrics` JSON snapshot (subset the Queue tab reads). */
export type ControlMetrics = {
  workflows: WorkflowStateCount[];
  rateLimits: { adapter: string; status: string }[];
  slots: { total: number };
  totals: { all: number; active: number; waitingHuman: number };
};

/** Fetch the aggregate queue gauges. Throws on a non-OK response. */
export async function fetchControlMetrics(): Promise<ControlMetrics> {
  const res = await fetch("/control/metrics");
  if (!res.ok) throw new Error(`/control/metrics ${res.status}`);
  return (await res.json()) as ControlMetrics;
}
