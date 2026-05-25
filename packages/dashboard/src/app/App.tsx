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
  SettingsWire,
} from "../wire.ts";
import { api } from "./api-client.ts";
import { ChannelSubscriber } from "./components/ChannelSubscriber.tsx";
import { GlobalBanner } from "./components/GlobalBanner.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { NeedsYou } from "./components/NeedsYou.tsx";
import { Repos } from "./components/Repos.tsx";
import { Settings } from "./components/Settings.tsx";

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
  const [view, setView] = useState<"dashboard" | "settings">("dashboard");
  const [settings, setSettings] = useState<SettingsWire | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshSettings = useCallback(async () => {
    setSettings(await api.settings());
  }, []);

  const saveGlobal = useCallback(
    async (patch: { maxConcurrent?: number; defaultAdapter?: string }) => {
      setSettings(await api.updateGlobalConfig(patch));
    },
    [],
  );

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

  const pauseRepo = useCallback(
    async (repo: string) => {
      await api.pauseRepo(repo);
      await Promise.all([refreshSettings(), refreshTop()]);
    },
    [refreshSettings, refreshTop],
  );

  const resumeRepo = useCallback(
    async (repo: string) => {
      await api.resumeRepo(repo);
      await Promise.all([refreshSettings(), refreshTop()]);
    },
    [refreshSettings, refreshTop],
  );

  const clearRateLimit = useCallback(
    async (adapter: string) => {
      await api.clearRateLimit(adapter);
      await Promise.all([refreshSettings(), refreshTop()]);
    },
    [refreshSettings, refreshTop],
  );

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

  // Load settings on first switch to the Settings view (and keep them fresh
  // while it's open — the poll tick re-fetches so a pause from elsewhere shows).
  useEffect(() => {
    if (view !== "settings") return;
    void refreshSettings();
    const id = setInterval(() => void refreshSettings(), POLL_MS);
    return () => clearInterval(id);
  }, [view, refreshSettings]);

  const inspectorSession = inspector?.panel.session ?? null;

  return (
    <div className="app">
      {/* Live channels: the banner updates within 2s of a rate-limit detection
          (#57), each expanded repo refreshes on a transition, and the open
          Inspector streams the session's hook events + runner-panel updates. */}
      <ChannelSubscriber
        url="/events/global"
        handlers={{ banner: (d) => setBanner(d as BannerData) }}
      />
      {[...expanded].map((repo) => (
        <ChannelSubscriber
          key={repo}
          url={`/events/repos/${encodeURIComponent(repo)}`}
          handlers={{
            repo: () => void refreshDetail(repo),
            workflow: () => void refreshDetail(repo),
          }}
        />
      ))}
      <ChannelSubscriber
        url={inspectorSession ? `/events/sessions/${encodeURIComponent(inspectorSession)}` : null}
        handlers={{
          "session-event": (d) =>
            setInspector((cur) =>
              cur ? { ...cur, events: [...cur.events, d as SessionEvent] } : cur,
            ),
          panel: (d) => setInspector((cur) => (cur ? { ...cur, panel: d as RunnerPanel } : cur)),
        }}
      />
      {banner ? <GlobalBanner banner={banner} /> : <header className="banner">⏵ middle</header>}
      {error ? <div className="error-bar">API error: {error}</div> : null}
      <nav className="view-nav">
        <button
          type="button"
          className={view === "dashboard" ? "active" : ""}
          onClick={() => setView("dashboard")}
        >
          dashboard
        </button>
        <button
          type="button"
          className={view === "settings" ? "active" : ""}
          onClick={() => setView("settings")}
        >
          settings
        </button>
      </nav>
      {view === "settings" ? (
        <main>
          {settings ? (
            <Settings
              settings={settings}
              banner={banner}
              onSaveGlobal={saveGlobal}
              onPauseRepo={pauseRepo}
              onResumeRepo={resumeRepo}
              onClearRateLimit={clearRateLimit}
            />
          ) : (
            <p className="empty">Loading settings…</p>
          )}
        </main>
      ) : (
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
      )}
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
