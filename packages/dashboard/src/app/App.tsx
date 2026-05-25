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
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { type GuardError, makeGuard } from "./guard.ts";
import { fetchControlMetrics, type ControlMetrics, type ControlWorkflowFrame } from "./control-client.ts";
import { ChannelSubscriber } from "./components/ChannelSubscriber.tsx";
import { GlobalBanner } from "./components/GlobalBanner.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { NeedsYou } from "./components/NeedsYou.tsx";
import { Queue } from "./components/Queue.tsx";
import { Repos } from "./components/Repos.tsx";
import { Settings } from "./components/Settings.tsx";

/** Poll cadence for the top-level read model until SSE replaces it (#57). */
const POLL_MS = 4000;

/** Lifecycle states that drop a workflow from the live queue (mirrors the old status page). */
const TERMINAL_QUEUE_STATES = new Set(["completed", "compensated", "failed", "cancelled"]);

/**
 * Pure reducer for the live-queue state — upserts non-terminal frames most-recent-first
 * and removes terminal frames. Extracted so the logic is unit-testable without a harness.
 */
export function applyWorkflowFrame(
  prev: ControlWorkflowFrame[],
  frame: ControlWorkflowFrame,
): ControlWorkflowFrame[] {
  const without = prev.filter((p) => p.id !== frame.id);
  return TERMINAL_QUEUE_STATES.has(frame.state) ? without : [frame, ...without];
}

export function App() {
  const [banner, setBanner] = useState<BannerData | null>(null);
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [needs, setNeeds] = useState<NeedsYouItem[]>([]);
  const [details, setDetails] = useState<Record<string, RepoDetail | undefined>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [inspector, setInspector] = useState<{ panel: RunnerPanel; events: SessionEvent[] } | null>(
    null,
  );
  const [view, setView] = useState<"dashboard" | "queue" | "settings">("dashboard");
  const [settings, setSettings] = useState<SettingsWire | null>(null);
  const [queueMetrics, setQueueMetrics] = useState<ControlMetrics | null>(null);
  const [queueLive, setQueueLive] = useState<ControlWorkflowFrame[]>([]);
  const [error, setError] = useState<GuardError | null>(null);

  // The uniform async-error funnel for every fire-and-forget API call below —
  // surface failures on the error bar, clear on the next same-source success.
  // See `guard.ts` for the source-keying rationale and the nesting gotcha.
  const guard = useMemo(() => makeGuard(setError), []);

  const refreshSettings = useCallback(
    () => guard("settings", async () => setSettings(await api.settings())),
    [guard],
  );

  const saveGlobal = useCallback(
    (patch: { maxConcurrent?: number; defaultAdapter?: string }) =>
      guard("settings", async () => setSettings(await api.updateGlobalConfig(patch))),
    [guard],
  );

  const refreshTop = useCallback(
    () =>
      guard("top", async () => {
        const [b, r, n] = await Promise.all([api.banner(), api.repos(), api.needsYou()]);
        setBanner(b);
        setRepos(r);
        setNeeds(n);
      }),
    [guard],
  );

  const refreshDetail = useCallback(
    (repo: string) =>
      guard(`detail:${repo}`, async () => {
        const detail = await api.repo(repo);
        setDetails((d) => ({ ...d, [repo]: detail }));
      }),
    [guard],
  );

  const pauseRepo = useCallback(
    (repo: string) =>
      guard("action", async () => {
        await api.pauseRepo(repo);
        await Promise.all([refreshSettings(), refreshTop()]);
      }),
    [guard, refreshSettings, refreshTop],
  );

  const resumeRepo = useCallback(
    (repo: string) =>
      guard("action", async () => {
        await api.resumeRepo(repo);
        await Promise.all([refreshSettings(), refreshTop()]);
      }),
    [guard, refreshSettings, refreshTop],
  );

  const clearRateLimit = useCallback(
    (adapter: string) =>
      guard("action", async () => {
        await api.clearRateLimit(adapter);
        await Promise.all([refreshSettings(), refreshTop()]);
      }),
    [guard, refreshSettings, refreshTop],
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

  // Raw inspector refresh: fetch the panel + events and update state, letting
  // errors propagate. `openInspector` wraps it in a guard for the unguarded
  // call sites (opening the drawer); `takeControl`/`release` await it *directly*
  // inside their own `guard("inspector", …)` so the single outer guard owns the
  // error. Nesting a second `guard("inspector", …)` here would swallow a refresh
  // failure and the outer success path would then clear it — the error vanishes.
  const loadInspector = useCallback(async (session: string) => {
    const [panel, events] = await Promise.all([api.session(session), api.sessionEvents(session)]);
    setInspector({ panel, events });
  }, []);

  const openInspector = useCallback(
    (session: string) => guard("inspector", () => loadInspector(session)),
    [guard, loadInspector],
  );

  const watch = useCallback((session: string) => {
    // Fire-and-forget (a watch attach changes no dashboard state), but surface a
    // failure rather than swallow it — the copy-command path is the fallback.
    api
      .attach(session, "watch")
      .catch((e) =>
        setError({ source: "inspector", message: e instanceof Error ? e.message : String(e) }),
      );
  }, []);

  const takeControl = useCallback(
    (session: string) =>
      guard("inspector", async () => {
        await api.attach(session, "control");
        if (inspector?.panel.session === session) await loadInspector(session);
        void refreshTop();
      }),
    [guard, inspector, loadInspector, refreshTop],
  );

  const release = useCallback(
    (session: string) =>
      guard("inspector", async () => {
        await api.release(session);
        if (inspector?.panel.session === session) await loadInspector(session);
        void refreshTop();
      }),
    [guard, inspector, loadInspector, refreshTop],
  );

  // Load settings on first switch to the Settings view (and keep them fresh
  // while it's open — the poll tick re-fetches so a pause from elsewhere shows).
  useEffect(() => {
    if (view !== "settings") return;
    void refreshSettings();
    const id = setInterval(() => void refreshSettings(), POLL_MS);
    return () => clearInterval(id);
  }, [view, refreshSettings]);

  // Fetch the queue metrics snapshot once when the Queue tab is opened. Routed
  // through `guard` like every other fetch so a backend failure surfaces on the
  // error bar (and clears on the next success) instead of silently blanking the
  // tab — a hidden empty state would mask a real /control/metrics outage.
  useEffect(() => {
    if (view !== "queue") return;
    void guard("queue", async () => setQueueMetrics(await fetchControlMetrics()));
  }, [view, guard]);

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
      <ChannelSubscriber
        url={view === "queue" ? "/control/events" : null}
        handlers={{
          workflow: (d) =>
            setQueueLive((prev) => applyWorkflowFrame(prev, d as ControlWorkflowFrame)),
        }}
      />
      {banner ? <GlobalBanner banner={banner} /> : <header className="banner">⏵ middle</header>}
      {error ? <div className="error-bar">API error: {error.message}</div> : null}
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
          className={view === "queue" ? "active" : ""}
          onClick={() => setView("queue")}
        >
          queue
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
      ) : view === "queue" ? (
        <Queue metrics={queueMetrics} live={queueLive} />
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
