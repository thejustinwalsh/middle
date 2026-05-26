/**
 * The JSON wire contract between the dashboard server (`api.ts`) and the React
 * SPA (`app/`). Kept in one place so the two halves can never drift: a route's
 * response type and the component that renders it import the same definition.
 *
 * Shapes here are the *projection* the dashboard needs — not the db rows. The
 * server's data seam ({@link ../deps.ts}) returns these directly; the app treats
 * them as read-only.
 */

/** Reactive rate-limit standing for one adapter (mirrors the dispatcher's `rate_limit_state`). */
export type RateLimitWire = {
  adapter: string;
  status: "AVAILABLE" | "RATE_LIMITED" | "UNKNOWN";
  /** Unix-ms when the limit resets; null when AVAILABLE/UNKNOWN. */
  resetAt: number | null;
};

/** GitHub API quota for the global banner. `UNKNOWN` when not tracked. */
export type GithubQuota = {
  status: "AVAILABLE" | "RATE_LIMITED" | "UNKNOWN";
  remaining: number | null;
  limit: number | null;
};

/** The top global banner: per-adapter rate limits + GitHub quota. */
export type GlobalBanner = {
  adapters: RateLimitWire[];
  github: GithubQuota;
};

/** One slot dimension as a pill: `claude 2/2`. */
export type SlotPill = {
  adapter: string;
  used: number;
  max: number;
};

/** A repo row in the Repos list (collapsed header state). */
export type RepoSummary = {
  /** `owner/name`. */
  repo: string;
  /** Per-adapter slot pills. */
  adapters: SlotPill[];
  /** The repo-total slot dimension. */
  total: { used: number; max: number };
  /** Auto-dispatch enabled (i.e. not paused). */
  auto: boolean;
};

/** A NEXT UP entry — the top of the recommender's ready-to-dispatch ranking. */
export type NextUpItem = {
  rank: number;
  epic: number;
  adapter: string;
  subIssues: number;
  reason: string;
};

/** A running runner as the Repos expansion / Inspector summarize it. */
export type RunnerSummary = {
  /** The tmux session name — the key for `/api/sessions/:session/*`. */
  session: string;
  workflowId: string;
  epic: number | null;
  adapter: string;
  /** `sub-issue 2/4` or `running`. */
  progress: string;
  state: string;
  controlledBy: "middle" | "human";
  /** Unix-ms of the last heartbeat, or null if none recorded. */
  lastHeartbeat: number | null;
  /** Copy-paste-accurate `tmux attach` commands (server-built, never client-derived). */
  attachCommands: AttachCommands;
};

/** The per-repo expansion: NEXT UP + IN FLIGHT + the repo's needs-human items. */
export type RepoDetail = RepoSummary & {
  nextUp: NextUpItem[];
  inFlight: RunnerSummary[];
};

/** One aggregated "Needs You" item (a needs-human row or a ready-for-review PR). */
export type NeedsYouItem = {
  repo: string;
  issue: number;
  /** Stable vocabulary: `fork tied`, `ambiguous criteria`, `ready for review`, … */
  label: string;
  oneLiner: string;
  /** A trailing markdown/URL link to the issue or PR. */
  link: string;
};

/** One persisted hook event in a session's timeline. */
export type SessionEvent = {
  ts: number;
  type: string;
  /** Parsed JSON payload (truncated upstream), or null. */
  payload: unknown;
};

/** The Inspector's per-runner panel — everything an operator needs to attach. */
export type RunnerPanel = {
  session: string;
  workflowId: string;
  repo: string;
  epic: number | null;
  adapter: string;
  state: string;
  controlledBy: "middle" | "human";
  /** Whether the tmux session is currently alive (joinable). */
  alive: boolean;
  lastHeartbeat: number | null;
  /** Best-effort context-token usage if the transcript/events expose it; else null. */
  contextTokens: number | null;
  transcriptPath: string | null;
  worktreePath: string | null;
  prNumber: number | null;
  prBranch: string | null;
  currentSubIssue: number | null;
  /** Copy-paste-accurate attach commands (the always-works fallback). */
  attachCommands: AttachCommands;
};

/** The two `tmux attach` invocations the Inspector exposes as copyable text. */
export type AttachCommands = {
  /** Read-only watch: `tmux attach -r -t <session>`. */
  watch: string;
  /** Read-write control: `tmux attach -t <session>`. */
  control: string;
};

/** Result of `POST /api/sessions/:session/attach`. */
export type AttachResult = {
  mode: "watch" | "control";
  /** The exact command spawned (or offered) for the operator's terminal. */
  command: string;
  /** Whether the dispatcher spawned a terminal (false → use the copy-command path). */
  spawned: boolean;
  /** The session's `controlled_by` after the call (control → `human`). */
  controlledBy: "middle" | "human";
};

/** One Epic card in the Epic-centric browse view — cache + workflows + state-issue join. */
export type EpicCard = {
  repo: string;
  number: number;
  title: string;
  /** Sub-issue progress from the cache. */
  progress: { closed: number; total: number };
  /** The runner working this Epic, when one is in flight. */
  runner: {
    adapter: string;
    state: string;
    currentSubIssue: number | null;
    session: string;
    prNumber: number | null;
  } | null;
  /**
   * A high-value decision callout from the state issue (needs-human / blocked).
   * `link` is a bare URL (extracted from the state-issue's `[text](url)` markdown)
   * — the SPA renders it directly as an `href`.
   */
  decision: { label: string; oneLiner: string; link?: string } | null;
  /** Force-dispatch affordance state. */
  dispatch: {
    /** True when a non-terminal workflow already owns this Epic (the 409 guard). */
    inFlight: boolean;
    /** The recommender's adapter pick (state-issue Ready row), the picker default. */
    recommendedAdapter: string | null;
    /** Per-adapter free-slot availability right now. */
    freeSlots: { adapter: string; available: boolean }[];
  };
};

/** One non-implementation run (recommender / documentation) in the Activity view. */
export type RunSummary = {
  workflowId: string;
  kind: "recommender" | "documentation";
  repo: string;
  state: string;
  /** `session_name ?? workflowId` — always set, so the row drills into the Inspector. */
  session: string;
  startedAt: number;
  updatedAt: number;
  /** `updatedAt - startedAt` for terminal runs; `now - startedAt` while active. */
  durationMs: number;
  active: boolean;
  hasTranscript: boolean;
  /** recommender → state-issue URL; documentation → PR URL; else null. */
  outputLink: string | null;
};

/** Per-repo config the Settings view edits. */
export type RepoConfigWire = {
  repo: string;
  auto: boolean;
  /** Unix-ms the pause expires, or null when not paused / paused indefinitely is `Number.MAX_SAFE_INTEGER`. */
  pausedUntil: number | null;
};

/** Global config the Settings view edits (the editable subset). */
export type GlobalConfigWire = {
  maxConcurrent: number;
  defaultAdapter: string;
};

/** The Settings view's full read model. */
export type SettingsWire = {
  global: GlobalConfigWire;
  repos: RepoConfigWire[];
};
