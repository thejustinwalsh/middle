/**
 * The operator console's left nav — brand mark, optional repo selector, view
 * nav, and the per-adapter rate-limit + GitHub-quota footer. Single source of
 * "where am I and what's the system doing right now."
 *
 * Renders identically inside the desktop fixed sidebar and inside the mobile
 * Sheet (the App owns the layout choice; this component is layout-agnostic).
 * Counts in the nav chips come from the App's live state; the LiveDot in the
 * brand mark glows when the recommender has run within the last
 * RECOMMENDER_LIVE_WINDOW_MS — silent confirmation the system is awake.
 */
import { Activity, Layers, LayoutDashboard, ListTodo, Settings as SettingsIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { GlobalBanner as BannerData, RepoSummary } from "../../wire.ts";
import { rateLimitLabel, untilReset } from "../format.ts";
import { cn } from "../lib/utils.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";

/** The five top-level views. Drives both desktop nav + mobile Sheet menu. */
export const SIDEBAR_VIEWS = ["epics", "dashboard", "queue", "activity", "settings"] as const;
export type SidebarView = (typeof SIDEBAR_VIEWS)[number];

type NavEntry = {
  view: SidebarView;
  label: string;
  Icon: ComponentType<{ className?: string }>;
};

const NAV: readonly NavEntry[] = [
  { view: "epics", label: "Epics", Icon: Layers },
  { view: "dashboard", label: "Dashboard", Icon: LayoutDashboard },
  { view: "queue", label: "Queue", Icon: ListTodo },
  { view: "activity", label: "Activity", Icon: Activity },
  { view: "settings", label: "Settings", Icon: SettingsIcon },
];

/** A live-recently dot: a soft pulse the operator catches in peripheral vision. */
function LiveDot({ live }: { live: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-1.5 rounded-full transition-colors duration-500",
        live ? "bg-primary shadow-[0_0_8px_var(--accent)]" : "bg-muted-foreground/40",
      )}
      style={live ? { animation: "sidebar-pulse 1.8s ease-in-out infinite" } : undefined}
    />
  );
}

/** A sidebar nav button. Active row owns the accent rule + softened bg. */
function NavButton({
  entry,
  active,
  count,
  onSelect,
}: {
  entry: NavEntry;
  active: boolean;
  count: number | null;
  onSelect: (view: SidebarView) => void;
}) {
  const { view, label, Icon } = entry;
  return (
    <button
      type="button"
      onClick={() => onSelect(view)}
      data-view={view}
      data-active={active ? "" : undefined}
      className={cn(
        "group relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left",
        "text-[13px] leading-none transition-colors duration-100",
        active
          ? "bg-[color:var(--panel-2)] text-foreground"
          : "text-[color:var(--fg-muted)] hover:bg-[color:var(--panel)] hover:text-foreground",
      )}
    >
      {/* The accent rule that anchors the active row — a 2px slab at the left.
          Visible only on active; the absolute position keeps the row body
          width stable so labels don't shift on selection. */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-1 left-0 w-[2px] rounded-full bg-primary opacity-0 transition-opacity",
          active && "opacity-100",
        )}
      />
      <Icon className="size-3.5 shrink-0 opacity-80 group-data-[active]:opacity-100" />
      <span className="flex-1 truncate">{label}</span>
      {count !== null && count > 0 ? (
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 font-mono text-[10px] leading-none tabular-nums",
            active
              ? "bg-primary/15 text-primary"
              : "bg-[color:var(--panel-2)] text-[color:var(--fg-muted)]",
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

/** A rate-limit row in the footer — adapter name + state dot + readable bit. */
function LimitRow({
  label,
  status,
  detail,
}: {
  label: string;
  status: "AVAILABLE" | "RATE_LIMITED" | "UNKNOWN";
  detail?: string | null;
}) {
  const dotClass =
    status === "AVAILABLE"
      ? "bg-primary"
      : status === "RATE_LIMITED"
        ? "bg-[color:var(--warn)]"
        : "bg-[color:var(--fg-dim)]";
  const labelClass =
    status === "AVAILABLE"
      ? "text-foreground"
      : status === "RATE_LIMITED"
        ? "text-[color:var(--warn)]"
        : "text-[color:var(--fg-dim)]";
  return (
    <div className="flex items-center gap-2 px-2.5 py-1">
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", dotClass)} />
      <span className="font-mono text-[11px] leading-none tracking-tight text-foreground">
        {label}
      </span>
      <span
        className={cn("ml-auto font-mono text-[10.5px] leading-none tabular-nums", labelClass)}
      >
        {detail ?? rateLimitLabel(status).toLowerCase()}
      </span>
    </div>
  );
}

/** Props the App passes down. Counts are optional; render nothing when null. */
export type SidebarProps = {
  view: SidebarView;
  onSelectView: (view: SidebarView) => void;
  banner: BannerData | null;
  /** Set when the recommender's last tick was within RECOMMENDER_LIVE_WINDOW_MS. */
  recommenderLive: boolean;
  repos: RepoSummary[];
  epicRepo: string | null;
  onSelectEpicRepo: (repo: string) => void;
  /** Per-view live counts ({@link SidebarView} → number). */
  counts?: Partial<Record<SidebarView, number>>;
  /** `now` anchor for resets — injected so tests are deterministic. */
  now?: number;
  /** Layout context — `narrow` drops the brand-mark wordmark for breathing room. */
  layout?: "wide" | "narrow";
};

/**
 * The sidebar's brand-mark row. The `▍` slab is a custom SVG so it doesn't
 * rely on the system font's vertical-line glyph (which renders inconsistently
 * across Plex Sans, Plex Mono, and fallback stacks). The LiveDot to its right
 * is the silent system-aliveness indicator.
 */
function BrandMark({ recommenderLive, layout }: { recommenderLive: boolean; layout: "wide" | "narrow" }) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-3.5">
      <svg
        aria-hidden="true"
        viewBox="0 0 12 16"
        className="size-3 shrink-0"
        fill="none"
      >
        <rect x="2" y="2" width="4" height="12" rx="1" fill="var(--accent)" />
        <rect x="7" y="2" width="3" height="12" rx="1" fill="var(--fg-muted)" />
      </svg>
      <span className="text-[13px] font-semibold tracking-tight text-foreground">
        middle
      </span>
      <span className="ml-auto">
        <LiveDot live={recommenderLive} />
      </span>
    </div>
  );
}

/**
 * The sidebar. Mounted inside both the fixed desktop column AND the mobile
 * Sheet — give it the same props in both places and it renders the same way.
 */
export function Sidebar(props: SidebarProps) {
  const {
    view,
    onSelectView,
    banner,
    recommenderLive,
    repos,
    epicRepo,
    onSelectEpicRepo,
    counts = {},
    now,
    layout = "wide",
  } = props;

  return (
    <aside
      data-slot="sidebar"
      className={cn(
        "flex h-full flex-col gap-3 border-r border-border bg-[color:var(--panel)]",
        layout === "wide" ? "w-[232px]" : "w-full",
      )}
    >
      <BrandMark recommenderLive={recommenderLive} layout={layout} />

      {/* Repo selector — only meaningful when multi-repo. Single-repo users
          never see this row; the App still resolves epicRepo to the only repo. */}
      {repos.length > 1 ? (
        <div className="px-3">
          <Select value={epicRepo ?? ""} onValueChange={onSelectEpicRepo}>
            <SelectTrigger
              aria-label="repo"
              className={cn(
                "h-8 w-full bg-[color:var(--panel-2)] font-mono text-[11.5px]",
                "border-[color:var(--border)] hover:bg-[color:var(--panel-hover)]",
              )}
            >
              <SelectValue placeholder="repo" />
            </SelectTrigger>
            <SelectContent>
              {repos.map((r) => (
                <SelectItem key={r.repo} value={r.repo} className="font-mono text-[12px]">
                  {r.repo}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <nav className="flex flex-col gap-0.5 px-2" aria-label="views">
        {NAV.map((entry) => (
          <NavButton
            key={entry.view}
            entry={entry}
            active={view === entry.view}
            count={counts[entry.view] ?? null}
            onSelect={onSelectView}
          />
        ))}
      </nav>

      <div className="flex-1" />

      <div className="border-t border-border">
        {banner ? (
          <div className="py-2">
            {banner.adapters.map((a) => (
              <LimitRow
                key={a.adapter}
                label={a.adapter}
                status={a.status}
                detail={untilReset(a.resetAt, now) || undefined}
              />
            ))}
            <LimitRow
              label="github"
              status={banner.github.status}
              detail={
                banner.github.remaining !== null && banner.github.limit !== null
                  ? `${banner.github.remaining}/${banner.github.limit}`
                  : null
              }
            />
          </div>
        ) : (
          <div className="px-3 py-3 font-mono text-[10.5px] tracking-tight text-[color:var(--fg-dim)]">
            booting limits…
          </div>
        )}
      </div>

      {/* Keyframes for the LiveDot pulse — keeping it co-located so the
          sidebar is self-contained. The animation runs only when `live` is
          true (the LiveDot's `style` carries the animation property). */}
      <style>{`
        @keyframes sidebar-pulse {
          0%, 100% { box-shadow: 0 0 0 0 var(--accent), 0 0 6px 0 var(--accent); opacity: 1; }
          50%      { box-shadow: 0 0 0 3px var(--accent-soft), 0 0 10px 0 var(--accent); opacity: 0.7; }
        }
      `}</style>
    </aside>
  );
}
