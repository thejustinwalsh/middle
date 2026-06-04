/**
 * The Activity view — recent recommender + documentation runs (the workflow kinds
 * the Epic/Queue views filter out), grouped by kind, newest-first. Each row drills
 * into the existing Inspector via its session. Read-only; the data is a snapshot
 * of `workflows` rows projected by {@link RunSummary}.
 */
import type { RunSummary } from "../../wire.ts";
import { ago } from "../format.ts";
import { Badge, type BadgeProps } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";

/** A coarse health class for the state pill. */
function tone(run: RunSummary): "active" | "ok" | "bad" {
  if (run.active) return "active";
  return run.state === "completed" ? "ok" : "bad";
}

/** Badge intent for a run tone. */
function toneVariant(t: "active" | "ok" | "bad"): BadgeProps["variant"] {
  return t === "ok" ? "success" : t === "bad" ? "destructive" : "default";
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
      <Button
        variant="link"
        className="run-open h-auto justify-start gap-2 p-0 text-foreground"
        onClick={() => onOpenInspector?.(run.session)}
      >
        <Badge variant={toneVariant(tone(run))} className={`run-state ${tone(run)}`}>
          {run.state}
        </Badge>
        <span className="run-repo">{run.repo}</span>
        <span className="run-when">
          {ago(run.startedAt, now)} ago · {Math.max(0, Math.round(run.durationMs / 1000))}s
        </span>
      </Button>
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
  const headingId = `run-section-${title.toLowerCase()}`;
  return (
    <section className="run-section" aria-labelledby={headingId}>
      <h3 id={headingId}>{title}</h3>
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

/**
 * The Activity tab. Splits `runs` into Recommender and Documentation sections
 * (each newest-first, with its own empty state) and renders one row per run; a
 * row click invokes `onOpenInspector(run.session)` to open the run's Inspector.
 * `now` (defaults to the live clock) is the reference point for relative times.
 */
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
