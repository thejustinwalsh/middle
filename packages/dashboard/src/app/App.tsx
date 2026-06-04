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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  EpicCard,
  GlobalBanner as BannerData,
  NeedsYouItem,
  RepoSummary,
  RunnerPanel,
  RunSummary,
  SessionEvent,
  SettingsWire,
} from "../wire.ts";
import { api } from "./api-client.ts";
import { type GuardError, makeGuard } from "./guard.ts";
import {
  fetchControlMetrics,
  type ControlMetrics,
  type ControlWorkflowFrame,
} from "./control-client.ts";
import { Menu, RefreshCw } from "lucide-react";
import { Button } from "./components/ui/button.tsx";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./components/ui/sheet.tsx";
import { Activity } from "./components/Activity.tsx";
import { ChannelSubscriber } from "./components/ChannelSubscriber.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { NeedsYou } from "./components/NeedsYou.tsx";
import { Epics } from "./components/Epics.tsx";
import { Queue } from "./components/Queue.tsx";
import { Repos } from "./components/Repos.tsx";
import { Settings } from "./components/Settings.tsx";
import { Sidebar, type SidebarView } from "./components/Sidebar.tsx";

/** Poll cadence for the top-level read model until SSE replaces it (#57). */
const POLL_MS = 4000;

/** The top-nav views, in order. Mirrored from {@link SIDEBAR_VIEWS}. */
type View = SidebarView;

/** Human-readable page titles for the breadcrumb topbar. */
const VIEW_TITLE: Record<View, string> = {
  epics: "Epics",
  dashboard: "Dashboard",
  queue: "Queue",
  activity: "Activity",
  settings: "Settings",
};

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

/**
 * The dashboard SPA root. Owns all view state (the active tab, expanded repos,
 * the open Inspector session, per-view data + errors) and wires the JSON API
 * (`/api/*`, `/control/metrics`) to the views, refreshing on a poll tick and via
 * the live SSE channels ({@link ChannelSubscriber}). Takes no props — it reads
 * everything from the same-origin daemon. Rendered once by `main.tsx`.
 */
export function App() {
  const [banner, setBanner] = useState<BannerData | null>(null);
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [needs, setNeeds] = useState<NeedsYouItem[]>([]);
  const [reloadSignals, setReloadSignals] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [inspector, setInspector] = useState<{ panel: RunnerPanel; events: SessionEvent[] } | null>(
    null,
  );
  const [view, setView] = useState<View>("epics");
  const [navOpen, setNavOpen] = useState(false);
  const [epics, setEpics] = useState<EpicCard[]>([]);
  const [epicRepo, setEpicRepo] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsWire | null>(null);
  const [queueMetrics, setQueueMetrics] = useState<ControlMetrics | null>(null);
  const [queueLive, setQueueLive] = useState<ControlWorkflowFrame[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runsLoaded, setRunsLoaded] = useState(false);
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

  // The repo expansion fetches its own detail (`RepoExpansion` owns the loading /
  // error / retry UI per #223); App only supplies the loader and bumps a per-repo
  // signal to refresh an open panel on a poll tick or SSE event.
  const loadDetail = useCallback((repo: string) => api.repo(repo), []);
  const bumpReload = useCallback(
    (repo: string) => setReloadSignals((s) => ({ ...s, [repo]: (s[repo] ?? 0) + 1 })),
    [],
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

  // Refresh every OPEN repo expansion on each poll tick: `repos` is replaced by
  // refreshTop every POLL_MS, so reacting to it bumps each expanded repo's reload
  // signal. Reacting to `repos` only (not `expanded`) avoids a double-load when a
  // repo is first opened — RepoExpansion already auto-loads on mount.
  useEffect(() => {
    for (const repo of expanded) bumpReload(repo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos]);

  const toggleRepo = useCallback((repo: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) {
        next.delete(repo);
      } else {
        next.add(repo);
      }
      return next;
    });
  }, []);

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

  // Fetch the queue metrics snapshot. Routed through `guard` so a backend failure
  // is keyed to the "queue" source — surfaced as an inline error panel in the
  // Queue view (with Retry), not a silent blank tab (#223).
  const refetchQueue = useCallback(
    () => guard("queue", async () => setQueueMetrics(await fetchControlMetrics())),
    [guard],
  );
  useEffect(() => {
    // Reset the incremental live frames on every view change. queueLive only
    // accumulates while the `/control/events` subscription is mounted (view ===
    // "queue"); without this, frames left over from a previous Queue visit would
    // linger — and re-merge with new frames — showing workflows that may have
    // since transitioned away while we were unsubscribed.
    setQueueLive([]);
    if (view !== "queue") return;
    void refetchQueue();
  }, [view, refetchQueue]);

  const refreshRuns = useCallback(
    () =>
      guard("activity", async () => {
        setRuns(await api.runs());
        setRunsLoaded(true);
      }),
    [guard],
  );

  // Load + poll the run history while the Activity view is open.
  useEffect(() => {
    if (view !== "activity") return;
    void refreshRuns();
    const id = setInterval(() => void refreshRuns(), POLL_MS);
    return () => clearInterval(id);
  }, [view, refreshRuns]);

  // Default the Epic-view repo filter to the first tracked repo once repos arrive.
  useEffect(() => {
    if (epicRepo === null && repos.length > 0) setEpicRepo(repos[0]!.repo);
  }, [repos, epicRepo]);

  const epicRepoRef = useRef<string | null>(null);
  useEffect(() => {
    epicRepoRef.current = epicRepo;
  }, [epicRepo]);

  const refreshEpics = useCallback(
    (repo: string) =>
      guard("epics", async () => {
        const next = await api.epics(repo);
        if (epicRepoRef.current === repo) setEpics(next);
      }),
    [guard],
  );

  const forceRefreshEpics = useCallback(
    (repo: string) =>
      guard("epics", async () => {
        await api.refreshEpics(repo);
        await refreshEpics(repo);
      }),
    [guard, refreshEpics],
  );

  // Load + poll the selected repo's Epics while the Epics view is open.
  useEffect(() => {
    if (view !== "epics" || epicRepo === null) return;
    void refreshEpics(epicRepo);
    const id = setInterval(() => void refreshEpics(epicRepo), POLL_MS);
    return () => clearInterval(id);
  }, [view, epicRepo, refreshEpics]);

  const dispatchEpic = useCallback(
    (repo: string, epicNumber: number, adapter: string) =>
      guard("epics", async () => {
        await api.dispatchEpic(repo, epicNumber, adapter);
        await Promise.all([refreshEpics(repo), refreshTop()]);
      }),
    [guard, refreshEpics, refreshTop],
  );

  const inspectorSession = inspector?.panel.session ?? null;

  // Live counts in the sidebar nav chips — derived from current state so they
  // stay in sync without a separate fetch. `dashboard` counts items pending the
  // operator; `queue` counts live active workflows; `epics` is the visible list
  // for the selected repo. Activity / Settings carry no count.
  const navCounts: Partial<Record<View, number>> = {
    epics: epics.length,
    dashboard: needs.length,
    queue: queueLive.length,
  };

  // The sidebar nav owns the view selection in both the desktop column and the
  // mobile Sheet — passed via this handler so the Sheet auto-closes on choose.
  const selectView = (v: View) => {
    setView(v);
    setNavOpen(false);
  };

  // System-aliveness signal: any open SSE channel means the daemon is talking
  // back. The actual recommender-tick wire-up is a Phase-5 follow-up — for now
  // "we have a banner from /events/global" is a faithful proxy.
  const recommenderLive = banner !== null;

  const sidebarProps = {
    view,
    onSelectView: selectView,
    banner,
    recommenderLive,
    repos,
    epicRepo,
    onSelectEpicRepo: (r: string) => {
      setEpicRepo(r);
      setEpics([]);
    },
    counts: navCounts,
  };

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Live channels — no visual; subscribe based on view + open expansions. */}
      <ChannelSubscriber
        url="/events/global"
        handlers={{ banner: (d) => setBanner(d as BannerData) }}
      />
      {[...expanded].map((repo) => (
        <ChannelSubscriber
          key={repo}
          url={`/events/repos/${encodeURIComponent(repo)}`}
          handlers={{
            repo: () => bumpReload(repo),
            workflow: () => bumpReload(repo),
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
      <ChannelSubscriber
        url={view === "epics" && epicRepo ? `/events/repos/${encodeURIComponent(epicRepo)}` : null}
        handlers={{ workflow: () => epicRepo && void refreshEpics(epicRepo) }}
      />
      <ChannelSubscriber
        url={view === "activity" ? "/control/events" : null}
        handlers={{ workflow: () => void refreshRuns() }}
      />

      {/* Desktop sidebar (≥md). The mobile sidebar lives in the Sheet below. */}
      <div className="hidden shrink-0 md:flex">
        <Sidebar {...sidebarProps} layout="wide" />
      </div>

      <div className="flex min-h-screen flex-1 flex-col">
        {/* Topbar — single hairline of structure across the top of the main
            column. Mobile hamburger (left) opens the sidebar Sheet. Breadcrumb
            (center-left) names the current view. Right cluster is per-view
            quick actions (e.g. epics refresh). */}
        <div className="sticky top-0 z-10 flex h-12 items-center gap-2 border-b border-border bg-background/85 px-4 backdrop-blur-sm">
          <Sheet open={navOpen} onOpenChange={setNavOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="menu" className="md:hidden">
                <Menu className="size-4" />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              aria-describedby={undefined}
              className="w-[260px] border-r border-border bg-[color:var(--panel)] p-0"
            >
              <SheetHeader className="sr-only">
                <SheetTitle>Views</SheetTitle>
              </SheetHeader>
              <Sidebar {...sidebarProps} layout="narrow" />
            </SheetContent>
          </Sheet>

          <div className="flex items-baseline gap-2">
            <h1 className="text-[15px] font-semibold tracking-tight text-foreground">
              {VIEW_TITLE[view]}
            </h1>
            {view === "epics" && epicRepo ? (
              <span className="font-mono text-[11.5px] text-[color:var(--fg-muted)]">
                {epicRepo}
              </span>
            ) : null}
          </div>

          <div className="ml-auto flex items-center gap-1">
            {view === "epics" && epicRepo ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => forceRefreshEpics(epicRepo)}
                className="h-8 gap-1.5 px-2 text-[12px] font-medium text-[color:var(--fg-muted)] hover:text-foreground"
              >
                <RefreshCw className="size-3.5" />
                refresh
              </Button>
            ) : null}
          </div>
        </div>

        {/* The error rail — only for sources without an inline panel; queue /
            activity surface their failure inside the view body (#223). */}
        {error && error.source !== "queue" && error.source !== "activity" ? (
          <div className="error-bar">API error: {error.message}</div>
        ) : null}

        {view === "epics" ? (
          <Epics
            epics={epics}
            adapters={(banner?.adapters ?? []).map((a) => a.adapter)}
            onDispatch={dispatchEpic}
            onOpenInspector={openInspector}
          />
        ) : view === "settings" ? (
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
          <Queue
            metrics={queueMetrics}
            live={queueLive}
            error={error?.source === "queue" ? error.message : undefined}
            onRetry={refetchQueue}
          />
        ) : view === "activity" ? (
          <Activity
            runs={runs}
            loaded={runsLoaded}
            error={error?.source === "activity" ? error.message : undefined}
            onRetry={refreshRuns}
            onOpenInspector={openInspector}
          />
        ) : (
          <main>
            <NeedsYou
              items={needs}
              onOpen={(item) => {
                // Opening expands the repo; RepoExpansion auto-loads its detail on mount.
                setExpanded((prev) => new Set(prev).add(item.repo));
              }}
            />
            <Repos
              repos={repos}
              expanded={expanded}
              reloadSignals={reloadSignals}
              loadDetail={loadDetail}
              onToggle={toggleRepo}
              onWatch={watch}
              onTakeControl={takeControl}
              onOpenInspector={openInspector}
            />
          </main>
        )}
      </div>

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
