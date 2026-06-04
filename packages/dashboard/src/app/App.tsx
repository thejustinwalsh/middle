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
  RepoDetail,
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
import { Menu } from "lucide-react";
import { Button } from "./components/ui/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./components/ui/sheet.tsx";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";
import { Activity } from "./components/Activity.tsx";
import { ChannelSubscriber } from "./components/ChannelSubscriber.tsx";
import { GlobalBanner } from "./components/GlobalBanner.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { NeedsYou } from "./components/NeedsYou.tsx";
import { Epics } from "./components/Epics.tsx";
import { Queue } from "./components/Queue.tsx";
import { Repos } from "./components/Repos.tsx";
import { Settings } from "./components/Settings.tsx";

/** Poll cadence for the top-level read model until SSE replaces it (#57). */
const POLL_MS = 4000;

/** The top-nav views, in order. Drives both the desktop Tabs and the mobile menu. */
const VIEWS = ["epics", "dashboard", "queue", "activity", "settings"] as const;
type View = (typeof VIEWS)[number];

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
  const [view, setView] = useState<View>("epics");
  const [navOpen, setNavOpen] = useState(false);
  const [epics, setEpics] = useState<EpicCard[]>([]);
  const [epicRepo, setEpicRepo] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsWire | null>(null);
  const [queueMetrics, setQueueMetrics] = useState<ControlMetrics | null>(null);
  const [queueLive, setQueueLive] = useState<ControlWorkflowFrame[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
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

  const refreshRuns = useCallback(
    () => guard("activity", async () => setRuns(await api.runs())),
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
      <ChannelSubscriber
        url={view === "epics" && epicRepo ? `/events/repos/${encodeURIComponent(epicRepo)}` : null}
        handlers={{ workflow: () => epicRepo && void refreshEpics(epicRepo) }}
      />
      <ChannelSubscriber
        url={view === "activity" ? "/control/events" : null}
        handlers={{ workflow: () => void refreshRuns() }}
      />
      {banner ? <GlobalBanner banner={banner} /> : <header className="banner">⏵ middle</header>}
      {error ? <div className="error-bar">API error: {error.message}</div> : null}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        {/* Mobile (<640px): the tabs collapse to a hamburger that opens a Sheet menu. */}
        <Sheet open={navOpen} onOpenChange={setNavOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="menu" className="sm:hidden">
              <Menu />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" aria-describedby={undefined} className="w-64">
            <SheetHeader>
              <SheetTitle>Views</SheetTitle>
            </SheetHeader>
            <nav className="flex flex-col gap-1">
              {VIEWS.map((v) => (
                <Button
                  key={v}
                  variant={view === v ? "secondary" : "ghost"}
                  className="justify-start"
                  onClick={() => {
                    setView(v);
                    setNavOpen(false);
                  }}
                >
                  {v}
                </Button>
              ))}
            </nav>
          </SheetContent>
        </Sheet>
        {/* Desktop (≥640px): the shadcn Tabs strip. */}
        <Tabs value={view} onValueChange={(v) => setView(v as View)} className="hidden sm:block">
          <TabsList aria-label="views">
            {VIEWS.map((v) => (
              <TabsTrigger key={v} value={v}>
                {v}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      {view === "epics" ? (
        <>
          <div className="epics-toolbar flex items-center gap-2 px-4 pt-4">
            {repos.length > 1 ? (
              <Select
                value={epicRepo ?? ""}
                onValueChange={(v) => {
                  setEpicRepo(v);
                  setEpics([]);
                }}
              >
                <SelectTrigger aria-label="repo" className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {repos.map((r) => (
                    <SelectItem key={r.repo} value={r.repo}>
                      {r.repo}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {epicRepo ? (
              <Button variant="outline" size="sm" onClick={() => forceRefreshEpics(epicRepo)}>
                refresh
              </Button>
            ) : null}
          </div>
          <Epics
            epics={epics}
            adapters={(banner?.adapters ?? []).map((a) => a.adapter)}
            onDispatch={dispatchEpic}
            onOpenInspector={openInspector}
          />
        </>
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
        <Queue metrics={queueMetrics} live={queueLive} />
      ) : view === "activity" ? (
        <Activity runs={runs} onOpenInspector={openInspector} />
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
