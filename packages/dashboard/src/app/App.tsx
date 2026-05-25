/**
 * The dashboard shell — fetches live state from the JSON API and renders the
 * three core views: the global banner, Needs You (primary), and Repos, with the
 * Issue Inspector drawer over the top. Until the SSE channels land (#57) it
 * refreshes by polling; #57 swaps the poll for live `/events/*` subscriptions.
 *
 * Data fetching and the operator actions (watch / take control / release) live
 * in the `api` client; this component owns view state (which repos are expanded,
 * which session the Inspector shows) and orchestrates refreshes.
 */
import { useCallback, useEffect, useState } from "react";
import type {
  GlobalBanner as BannerData,
  NeedsYouItem,
  RepoDetail,
  RepoSummary,
  RunnerPanel,
  SessionEvent,
} from "../wire.ts";
import { api } from "./api-client.ts";
import { GlobalBanner } from "./components/GlobalBanner.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { NeedsYou } from "./components/NeedsYou.tsx";
import { Repos } from "./components/Repos.tsx";

/** Poll cadence for the top-level read model until SSE replaces it (#57). */
const POLL_MS = 4000;

export function App() {
  const [banner, setBanner] = useState<BannerData | null>(null);
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [needs, setNeeds] = useState<NeedsYouItem[]>([]);
  const [details, setDetails] = useState<Record<string, RepoDetail | undefined>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [inspector, setInspector] = useState<{ panel: RunnerPanel; events: SessionEvent[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const refreshTop = useCallback(async () => {
    try {
      const [b, r, n] = await Promise.all([api.banner(), api.repos(), api.needsYou()]);
      setBanner(b);
      setRepos(r);
      setNeeds(n);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refreshDetail = useCallback(async (repo: string) => {
    const detail = await api.repo(repo);
    setDetails((d) => ({ ...d, [repo]: detail }));
  }, []);

  // Initial load + poll. (Phase #57 replaces the interval with SSE.)
  useEffect(() => {
    void refreshTop();
    const id = setInterval(() => void refreshTop(), POLL_MS);
    return () => clearInterval(id);
  }, [refreshTop]);

  // Keep every expanded repo's detail fresh on each poll tick.
  useEffect(() => {
    for (const repo of expanded) void refreshDetail(repo);
  }, [expanded, repos, refreshDetail]);

  const toggleRepo = useCallback(
    (repo: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(repo)) {
          next.delete(repo);
        } else {
          next.add(repo);
          void refreshDetail(repo);
        }
        return next;
      });
    },
    [refreshDetail],
  );

  const openInspector = useCallback(async (session: string) => {
    const [panel, events] = await Promise.all([api.session(session), api.sessionEvents(session)]);
    setInspector({ panel, events });
  }, []);

  const watch = useCallback((session: string) => {
    void api.attach(session, "watch");
  }, []);

  const takeControl = useCallback(
    async (session: string) => {
      await api.attach(session, "control");
      if (inspector?.panel.session === session) await openInspector(session);
      void refreshTop();
    },
    [inspector, openInspector, refreshTop],
  );

  const release = useCallback(
    async (session: string) => {
      await api.release(session);
      if (inspector?.panel.session === session) await openInspector(session);
      void refreshTop();
    },
    [inspector, openInspector, refreshTop],
  );

  return (
    <div className="app">
      {banner ? <GlobalBanner banner={banner} /> : <header className="banner">⏵ middle</header>}
      {error ? <div className="error-bar">API error: {error}</div> : null}
      <main>
        <NeedsYou
          items={needs}
          onOpen={(item) => {
            const repo = item.repo;
            setExpanded((prev) => new Set(prev).add(repo));
            void refreshDetail(repo);
          }}
        />
        <Repos
          repos={repos}
          details={details}
          expanded={expanded}
          onToggle={toggleRepo}
          onWatch={watch}
          onTakeControl={takeControl}
          onOpenInspector={openInspector}
        />
      </main>
      {inspector ? (
        <Inspector
          panel={inspector.panel}
          events={inspector.events}
          transcriptUrl={
            inspector.panel.transcriptPath ? api.transcriptUrl(inspector.panel.session) : undefined
          }
          onClose={() => setInspector(null)}
          onWatch={watch}
          onTakeControl={takeControl}
          onRelease={release}
        />
      ) : null}
    </div>
  );
}
