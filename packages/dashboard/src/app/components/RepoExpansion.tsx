import type { RepoDetail } from "../../wire.ts";
import { useAsyncResource } from "../useAsyncResource.ts";
import { InlineError } from "./InlineError.tsx";
import { RunnerRow } from "./RunnerRow.tsx";
import { Skeleton } from "./ui/skeleton.tsx";

/** Placeholder shown while a repo's detail is loading. */
function RepoExpansionSkeleton() {
  return (
    <div className="repo-expansion-skeleton flex flex-col gap-2 py-2 pl-4" aria-busy="true">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

/**
 * The body of an expanded repo row: NEXT UP + IN FLIGHT. Self-fetching via
 * {@link useAsyncResource} (calling `loader(signal)`, which must honor the abort
 * signal) so it owns its own loading / error / retry UI (#223): a Skeleton while
 * the detail is in flight, an {@link InlineError} (with Retry) on failure or
 * timeout, the content on success. Bumping `reloadSignal` forces a refresh of an
 * already-open panel (App does this on a poll tick or SSE event); `now` anchors
 * relative timestamps, and the optional `onWatch`/`onTakeControl`/
 * `onOpenInspector` callbacks pass through to each {@link RunnerRow}.
 */
export function RepoExpansion({
  loader,
  reloadSignal = 0,
  now,
  onWatch,
  onTakeControl,
  onOpenInspector,
}: {
  /** Fetch this repo's detail (App passes `() => api.repo(repo)`). */
  loader: (signal: AbortSignal) => Promise<RepoDetail>;
  /** Bump to force a refresh of an open panel (poll tick / SSE event). */
  reloadSignal?: number;
  now?: number;
  onWatch?: (session: string) => void;
  onTakeControl?: (session: string) => void;
  onOpenInspector?: (session: string) => void;
}) {
  const { status, data, error, reload } = useAsyncResource(loader, { deps: [reloadSignal] });

  if (status === "loading") return <RepoExpansionSkeleton />;
  if (status === "error" || status === "timeout") {
    return (
      <div className="repo-expansion py-2 pl-4">
        <InlineError message={error} onRetry={reload} timedOut={status === "timeout"} />
      </div>
    );
  }

  const detail = data!;
  return (
    <div className="repo-expansion flex flex-col gap-4 py-2 pl-4 md:flex-row">
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
    </div>
  );
}
