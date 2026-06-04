import type { RepoDetail, RepoSummary } from "../../wire.ts";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx";
import { RepoExpansion } from "./RepoExpansion.tsx";

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
 * `expanded`, reveals NEXT UP and IN FLIGHT via {@link RepoExpansion} (which
 * loads `loadDetail(repo)` itself). The header click delegates to `onToggle`; the
 * runner affordances pass through to each {@link RunnerRow}. `reloadSignal` lets
 * App refresh an open panel on a poll tick or SSE event.
 */
export function RepoRow({
  summary,
  expanded,
  reloadSignal,
  now,
  loadDetail,
  onToggle,
  onWatch,
  onTakeControl,
  onOpenInspector,
}: {
  summary: RepoSummary;
  expanded: boolean;
  reloadSignal?: number;
  now?: number;
  loadDetail: (repo: string, signal: AbortSignal) => Promise<RepoDetail>;
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
        <CollapsibleContent>
          <RepoExpansion
            loader={(signal) => loadDetail(summary.repo, signal)}
            reloadSignal={reloadSignal}
            now={now}
            onWatch={onWatch}
            onTakeControl={onTakeControl}
            onOpenInspector={onOpenInspector}
          />
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/**
 * The Repos list: renders one {@link RepoRow} per `repos` entry, each a header
 * (slot pills + auto-dispatch state) that, when its id is in the `expanded` set,
 * reveals NEXT UP and IN FLIGHT. The expansion body ({@link RepoExpansion})
 * fetches its own detail lazily via `loadDetail(repo, signal)` (must honor the
 * abort signal) and owns its loading/error/retry UI, so a collapsed repo costs
 * nothing and a failed fetch recovers in place. `reloadSignals` maps a repo id to
 * a counter — bumping it refreshes that open panel; `now` anchors relative
 * timestamps. `onToggle` fires with the clicked repo; the optional `onWatch`/
 * `onTakeControl`/`onOpenInspector` receive a session id.
 */
export function Repos({
  repos,
  expanded,
  reloadSignals,
  now,
  loadDetail,
  onToggle,
  onWatch,
  onTakeControl,
  onOpenInspector,
}: {
  repos: RepoSummary[];
  expanded: Set<string>;
  reloadSignals: Record<string, number>;
  now?: number;
  loadDetail: (repo: string, signal: AbortSignal) => Promise<RepoDetail>;
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
              expanded={expanded.has(r.repo)}
              reloadSignal={reloadSignals[r.repo]}
              now={now}
              loadDetail={loadDetail}
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
