/**
 * The Activity view — recent recommender + documentation runs (the workflow kinds
 * the Epic/Queue views filter out), grouped by kind, newest-first. Each row drills
 * into the existing Inspector via its session. Read-only; the data is a snapshot
 * of `workflows` rows projected by {@link RunSummary}.
 */
import type { RunSummary } from "../../wire.ts";
import { ago } from "../format.ts";

/** A coarse health class for the state pill. */
function tone(run: RunSummary): "active" | "ok" | "bad" {
  if (run.active) return "active";
  return run.state === "completed" || run.state === "compensated" ? "ok" : "bad";
}

function RunRow({
  run,
  now,
  onOpenInspector,
}: {
  run: RunSummary;
  now?: number;
  onOpenInspector?: (session: string) => void;
}) {
  return (
    <li className="run-row" data-run={run.workflowId}>
      <button type="button" className="run-open" onClick={() => onOpenInspector?.(run.session)}>
        <span className={`run-state ${tone(run)}`}>{run.state}</span>
        <span className="run-repo">{run.repo}</span>
        <span className="run-when">
          {ago(run.startedAt, now)} ago · {Math.round(run.durationMs / 1000)}s
        </span>
      </button>
      {run.outputLink ? (
        <a className="run-output" href={run.outputLink}>
          ↗ output
        </a>
      ) : null}
    </li>
  );
}

function Section({
  title,
  runs,
  emptyLabel,
  now,
  onOpenInspector,
}: {
  title: string;
  runs: RunSummary[];
  emptyLabel: string;
  now?: number;
  onOpenInspector?: (session: string) => void;
}) {
  return (
    <section className="run-section">
      <h3>{title}</h3>
      {runs.length === 0 ? (
        <p className="empty">{emptyLabel}</p>
      ) : (
        <ul>
          {runs.map((run) => (
            <RunRow key={run.workflowId} run={run} now={now} onOpenInspector={onOpenInspector} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function Activity({
  runs,
  now,
  onOpenInspector,
}: {
  runs: RunSummary[];
  now?: number;
  onOpenInspector?: (session: string) => void;
}) {
  const recommender = runs.filter((r) => r.kind === "recommender");
  const documentation = runs.filter((r) => r.kind === "documentation");
  return (
    <section className="activity" aria-labelledby="activity-h">
      <h2 id="activity-h">ACTIVITY</h2>
      <Section
        title="Recommender"
        runs={recommender}
        emptyLabel="No recommender runs yet."
        now={now}
        onOpenInspector={onOpenInspector}
      />
      <Section
        title="Documentation"
        runs={documentation}
        emptyLabel="No documentation runs yet."
        now={now}
        onOpenInspector={onOpenInspector}
      />
    </section>
  );
}
