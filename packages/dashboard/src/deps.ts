/**
 * The dashboard's injectable data + action seam — the single boundary between
 * the HTTP routes and live infrastructure (the SQLite db, the GitHub state
 * issue, tmux, the dispatcher's control plane). Mirrors the dispatcher's
 * `ControlPlane` pattern (`hook-server.ts`): every route is written against this
 * interface, so the whole API unit-tests with an in-memory fake — no daemon, no
 * real db, no GitHub. {@link ./db-deps.ts} is the production implementation.
 */

import type { EventHub } from "@middle/dispatcher/src/event-hub.ts";
import type {
  AttachResult,
  GlobalBanner,
  NeedsYouItem,
  RepoDetail,
  RepoSummary,
  RunnerPanel,
  SessionEvent,
  SettingsWire,
} from "./wire.ts";

/** A streamed transcript read: the on-disk JSONL path and a lazily-opened stream. */
export type TranscriptRead = {
  path: string;
  /** The file contents as a stream; the route pipes it straight to the Response. */
  stream: ReadableStream<Uint8Array>;
};

/**
 * Everything the dashboard routes need. Read methods project db/state-issue data
 * into the wire types; action methods perform the operator commands. Methods are
 * async so a real implementation can hit the db, the filesystem, or GitHub; the
 * fake resolves synchronously.
 */
export type DashboardDeps = {
  /** The global banner: per-adapter rate limits + GitHub quota. */
  banner(): Promise<GlobalBanner>;

  /** Every repo middle tracks, with summary slot + auto state. */
  listRepos(): Promise<RepoSummary[]>;

  /** One repo's detail (NEXT UP + IN FLIGHT), or null if the repo is unknown. */
  getRepo(repo: string): Promise<RepoDetail | null>;

  /** Aggregated Needs-You items across every repo (needs-human + ready-for-review). */
  needsYou(): Promise<NeedsYouItem[]>;

  /** A session's Inspector panel, or null if no workflow owns the session. */
  getRunnerPanel(session: string): Promise<RunnerPanel | null>;

  /** A session's hook-event timeline, newest-last. `null` → unknown session. */
  getSessionEvents(session: string, limit?: number): Promise<SessionEvent[] | null>;

  /** A session's on-disk transcript, or null if none is recorded. */
  getTranscript(session: string): Promise<TranscriptRead | null>;

  /**
   * Attach the operator to a live session. `watch` → read-only; `control` flips
   * `controlled_by` to `human` and suspends middle's driving. Spawns the
   * operator's terminal best-effort; the returned command always works as a
   * copy-paste fallback. `null` → unknown session.
   */
  attach(session: string, mode: "watch" | "control"): Promise<AttachResult | null>;

  /** Return control to middle (`controlled_by` → `middle`). `false` → unknown session. */
  release(session: string): Promise<boolean>;

  /** The Settings read model: global config + per-repo config. */
  getSettings(): Promise<SettingsWire>;

  /** Clear an adapter's rate limit (manual override → AVAILABLE). */
  clearRateLimit(adapter: string): Promise<void>;

  /** Pause auto-dispatch for a repo. `untilMs` omitted → indefinite. */
  pauseRepo(repo: string, untilMs?: number): Promise<void>;

  /** Resume auto-dispatch for a repo. */
  resumeRepo(repo: string): Promise<void>;

  /** Edit the editable global config subset. Persisted; reflected back by `getSettings`. */
  updateGlobalConfig(
    patch: Partial<{ maxConcurrent: number; defaultAdapter: string }>,
  ): Promise<void>;

  /**
   * Trigger a recommender run for a repo. Returns the dispatcher's status/body.
   * `null` → no trigger is wired (read-only/standalone mode → the route 404s).
   */
  runRecommender?(repo: string): Promise<{ status: number; body: string }>;

  /**
   * The SSE hub for live fan-out, when wired. Absent → the `/events/*` routes
   * 404 (a poll-only deployment). Phase #57 wires this.
   */
  hub?: EventHub;
};
