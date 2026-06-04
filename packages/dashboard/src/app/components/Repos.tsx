/**
 * The Repos list: a per-repo header (slot pills + auto-dispatch state) that
 * expands to NEXT UP (top of the recommender's ready ranking) and IN FLIGHT
 * (the running runners). Detail is fetched lazily on expand and passed in via
 * `details`, so a collapsed repo costs nothing.
 */
import type { RepoDetail, RepoSummary } from "../../wire.ts";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx";
import { RunnerRow } from "./RunnerRow.tsx";

function SlotPills({ summary }: { summary: RepoSummary }) {
  return (
    <span className="slot-pills flex flex-wrap items-center gap-1">
      {summary.adapters.map((a) => (
        <Badge key={a.adapter} variant="outline">
          {a.adapter} {a.used}/{a.max}
        </Badge>
      ))}
      <Badge variant="outline">
        total {summary.total.used}/{summary.total.max}
      </Badge>
      <Badge variant={summary.auto ? "success" : "destructive"}>
        auto {summary.auto ? "✓" : "✗"}
      </Badge>
    </span>
  );
}

/**
 * A single repo row: a header (slot pills + auto-dispatch state) that, when
 * `expanded` and its `detail` has loaded, reveals NEXT UP and IN FLIGHT. The
 * header click delegates to `onToggle`; the runner affordances
 * (`onWatch`/`onTakeControl`/`onOpenInspector`) pass through to each
 * {@link RunnerRow}. A collapsed row (or one whose `detail` hasn't arrived)
 * renders only the header.
 */
export function RepoRow({
  summary,
  detail,
  expanded,
  now,
  onToggle,
  onWatch,
  onTakeControl,
  onOpenInspector,
}: {
  summary: RepoSummary;
  detail?: RepoDetail;
  expanded: boolean;
  now?: number;
  onToggle: (repo: string) => void;
  onWatch?: (session: string) => void;
  onTakeControl?: (session: string) => void;
  onOpenInspector?: (session: string) => void;
}) {
  return (
    <li className="repo-row" data-repo={summary.repo}>
      <Collapsible open={expanded} onOpenChange={() => onToggle(summary.repo)}>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="repo-header flex h-auto w-full items-center justify-between gap-2 py-2"
          >
            <span className="repo-name font-medium">{summary.repo}</span>
            <SlotPills summary={summary} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="repo-expansion flex flex-col gap-4 py-2 pl-4 md:flex-row">
          {detail ? (
            <>
              <div className="next-up flex-1">
                <h4>NEXT UP</h4>
                {detail.nextUp.length === 0 ? (
                  <p className="empty">—</p>
                ) : (
                  <ol>
                    {detail.nextUp.map((n) => (
                      <li key={n.epic}>
                        #{n.epic} · {n.adapter} · {n.subIssues} sub-issues — {n.reason}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
              <div className="in-flight flex-1">
                <h4>IN FLIGHT</h4>
                {detail.inFlight.length === 0 ? (
                  <p className="empty">—</p>
                ) : (
                  <ul>
                    {detail.inFlight.map((r) => (
                      <RunnerRow
                        key={r.session}
                        runner={r}
                        now={now}
                        onWatch={onWatch}
                        onTakeControl={onTakeControl}
                        onOpenInspector={onOpenInspector}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

export function Repos({
  repos,
  details,
  expanded,
  now,
  onToggle,
  onWatch,
  onTakeControl,
  onOpenInspector,
}: {
  repos: RepoSummary[];
  details: Record<string, RepoDetail | undefined>;
  expanded: Set<string>;
  now?: number;
  onToggle: (repo: string) => void;
  onWatch?: (session: string) => void;
  onTakeControl?: (session: string) => void;
  onOpenInspector?: (session: string) => void;
}) {
  return (
    <section className="repos" aria-labelledby="repos-h">
      <h2 id="repos-h">REPOS</h2>
      {repos.length === 0 ? (
        <p className="empty">No repos tracked yet.</p>
      ) : (
        <ul>
          {repos.map((r) => (
            <RepoRow
              key={r.repo}
              summary={r}
              detail={details[r.repo]}
              expanded={expanded.has(r.repo)}
              now={now}
              onToggle={onToggle}
              onWatch={onWatch}
              onTakeControl={onTakeControl}
              onOpenInspector={onOpenInspector}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
