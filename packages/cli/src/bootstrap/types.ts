// Shared types for the `mm init` / `mm uninit` bootstrap flow.

/** The bootstrap schema version written to `[bootstrap] version`. v1 today. */
export const BOOTSTRAP_VERSION = 1;

export const STATE_LABEL = "agent-queue:state";
export const STATE_LABEL_COLOR = "6f42c1";
export const STATE_ISSUE_TITLE = "agent-queue: dispatch state";

/** Identity of the target repo, resolved from its `origin` remote. */
export type RepoInfo = {
  owner: string;
  name: string;
  defaultBranch: string;
};

/**
 * The GitHub mutations bootstrap performs. Isolated behind an interface so
 * `mm init`/`mm uninit` tests run against a scratch git repo without touching
 * GitHub. The real implementation (gh-backed) lives in `deps.ts`; the empty
 * schema-conforming body it creates is owned by sub-issue #24.
 */
export type GithubGateway = {
  /** Create the `agent-queue:state` label (color 6f42c1) if absent. */
  ensureStateLabel(info: RepoInfo): Promise<void>;
  /**
   * Open issues carrying the state label, oldest-first (the oldest is the
   * canonical one). Empty when none exist. Lets `mm init` reconcile against
   * GitHub — the source of truth — rather than file a duplicate state issue when
   * a second machine / fresh clone has no local `config.toml` cache.
   */
  findStateIssues(info: RepoInfo): Promise<number[]>;
  /** Create the state issue with the given body; return its issue number. */
  createStateIssue(info: RepoInfo, title: string, body: string): Promise<number>;
  /** Close the state issue with a comment. No-op if the number is 0/unknown. */
  closeStateIssue(info: RepoInfo, issue: number, comment: string): Promise<void>;
};

/** Side-effecting externals bootstrap depends on, injected for testability. */
export type BootstrapDeps = {
  /** True iff the repo's working tree has no staged/unstaged changes. */
  isCleanWorktree(repo: string): Promise<boolean>;
  /** The `origin` remote URL, or null if there is none. */
  getRemoteUrl(repo: string): Promise<string | null>;
  /** True iff `gh` is authenticated. */
  isGhAuthenticated(): Promise<boolean>;
  /** Resolve owner/name/defaultBranch for the repo. */
  resolveRepoInfo(repo: string): Promise<RepoInfo>;
  github: GithubGateway;
  /** Clock seam — the state-issue `generated` timestamp and `installed_at`. */
  now(): Date;
};

export type BootstrapOptions = {
  dryRun: boolean;
};

/** What `mm init` did (or, under `--dry-run`, would do). */
export type InitResult = {
  dryRun: boolean;
  /** "fresh", "reinit" (matching version), or "migrate" (differing version). */
  mode: "fresh" | "reinit" | "migrate";
  info: RepoInfo;
  stateIssue: number;
  /** Human-readable lines describing each performed/planned action. */
  actions: string[];
};

export type UninitResult = {
  dryRun: boolean;
  stateIssue: number;
  actions: string[];
};
