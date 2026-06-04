import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";

/**
 * Minimal config consumed by `@middle/state-issue`'s `validate()` — just the
 * configured adapter names. Kept as its own narrow type so the state-issue
 * package does not depend on the full `MiddleConfig` shape.
 */
export type RepoConfig = {
  /** Configured adapter names, e.g. ["claude", "codex"]. */
  adapters: string[];
};

export type AdapterConfig = {
  enabled: boolean;
  binary: string;
  /** Claude only. */
  permissionMode?: string;
  /** Codex only. */
  sandbox?: string;
  /** Codex only. */
  approvalPolicy?: string;
  extraArgs: string[];
};

export type GlobalSettings = {
  dispatcherPort: number;
  maxConcurrent: number;
  defaultAdapter: string;
  logDir: string;
  worktreeRoot: string;
  dbPath: string;
};

export type DashboardSettings = {
  windowed: boolean;
  theme: string;
};

export type RepoSettings = {
  owner: string;
  name: string;
  defaultBranch: string;
  prMode: string;
};

export type LimitsSettings = {
  maxConcurrent: number;
  maxConcurrentPerAdapter: Record<string, number>;
  complexityCeiling: number;
};

export type RecommenderSettings = {
  enabled: boolean;
  intervalMinutes: number;
  adapter: string;
  autoDispatch: boolean;
  /**
   * Hard cap on the recommender agent run, in milliseconds (from
   * `agent_timeout_minutes`). Undefined when unset — the workflow then applies
   * its own default. Operators bump this for repos large enough that ranking +
   * rewriting the state issue doesn't finish inside the default window.
   */
  agentTimeoutMs?: number;
  /**
   * Max number of managed repos whose recommender runs fire **concurrently** in
   * one cron pass (#227, from `max_concurrent_repos`). The cron parallelizes
   * per-repo runs so a hung repo can't block the others; this bounds the fan-out
   * to protect rate limits + memory. Daemon-global (read from the global config).
   * Undefined → the cron's default (4).
   */
  maxConcurrentRepos?: number;
  /**
   * Hard timeout for a single repo's recommender run inside the cron pass, in
   * milliseconds (#227, from `run_timeout_seconds`). A run exceeding this is
   * abandoned and marked failed for that repo (stamp rolled back) without
   * affecting the others. Undefined → the cron's default (60s).
   */
  runTimeoutMs?: number;
};

export type StateIssueSettings = {
  number: number;
  label: string;
};

/**
 * The `[docs]` section — dual purpose. It configures the docs-harvester bot
 * (`enabled`, `intervalMinutes`, `adapter`, `write`) *and* overrides the docs
 * target resolver (`tool`, `path`). The override fields are optional: a block
 * that sets only `tool`/`path` forces the resolver's target without enabling
 * the bot, so the bot fields fall back to documented defaults rather than
 * requiring the whole block.
 */
export type DocsSettings = {
  /** Whether the docs bot runs at all. Default false (opt-in). */
  enabled: boolean;
  /** Cron cadence, mirroring the recommender. Default 60. */
  intervalMinutes: number;
  /** Adapter the docs agent runs with. Default "claude". */
  adapter: string;
  /** When false (default), the bot audits/dry-runs only and writes nothing. */
  write: boolean;
  /** Force a docs target by name, overriding detection. Omit to auto-detect. */
  tool?: string;
  /** Override the output root, overriding the detected target's default. */
  path?: string;
};

export type BootstrapSettings = {
  version: number;
  installedAt: string;
};

/**
 * The `[epic_store]` section — selects where a repo's Epics + dispatch state live.
 * Absent (or `mode = "github"`) means the default GitHub-backed store (Epics are
 * issues, state is a state issue). `mode = "file"` is the file-backed store (#190):
 * Epics are Markdown files under `epicsDir` and the ranked dispatch state is
 * `stateFile`. Mirrors the DB `repo_config` columns (migration 008) — `mm init`
 * writes both; the config-toml copy is what config-only callers (the recommender
 * run resolution) read to learn a repo is file-mode without a DB handle (#200).
 */
export type EpicStoreSettings = {
  mode: "github" | "file";
  /** Repo-relative Epic directory (file mode). */
  epicsDir?: string;
  /** Repo-relative ranked-state file (file mode). */
  stateFile?: string;
};

/**
 * The `[staleness]` section — per-repo overrides for the anti-staleness drift
 * check. `spec_path` is the repo-relative build-spec path the check reads; omit
 * it to keep the dispatcher's default convention. The whole section is optional,
 * and so is every field within it (a bare `[staleness]` block is valid and just
 * means "use the defaults") — a repo that doesn't ship a spec at all still gets
 * the landed-issue reconcile, just no drift check.
 */
export type StalenessSettings = {
  /** Repo-relative build-spec path the drift check reads. Omit for the default. */
  specPath?: string;
};

/**
 * The merged result of the global and per-repo config files. The global-derived
 * sections are always present (documented defaults fill any gap); the per-repo
 * sections are present only when a per-repo config file was loaded.
 */
export type MiddleConfig = {
  global: GlobalSettings;
  adapters: Record<string, AdapterConfig>;
  dashboard: DashboardSettings;
  repo?: RepoSettings;
  limits?: LimitsSettings;
  recommender?: RecommenderSettings;
  stateIssue?: StateIssueSettings;
  epicStore?: EpicStoreSettings;
  bootstrap?: BootstrapSettings;
  docs?: DocsSettings;
  staleness?: StalenessSettings;
};

export type LoadConfigOptions = {
  /** Path to the global config; defaults to `~/.middle/config.toml`. */
  globalPath?: string;
  /** Path to the per-repo local cache (`<repo>/.middle/config.toml`); optional. */
  repoPath?: string;
  /**
   * Path to the committed per-repo policy (`<repo>/.middle/policy.toml`). When
   * omitted but `repoPath` is set, it defaults to `policy.toml` alongside
   * `repoPath` — so the 8+ existing call sites that pass only `repoPath` pick up
   * committed policy with no change. Pass explicitly to point elsewhere (tests).
   */
  repoPolicyPath?: string;
};

type RawTable = Record<string, unknown>;

/** Documented defaults from the build spec's "Global config" block. */
const GLOBAL_DEFAULTS: RawTable = {
  global: {
    dispatcher_port: 4120,
    max_concurrent: 4,
    default_adapter: "claude",
    log_dir: "~/.middle/logs",
    worktree_root: "~/.middle/worktrees",
    db_path: "~/.middle/db.sqlite3",
  },
  adapters: {
    claude: { enabled: true, binary: "claude", permission_mode: "auto", extra_args: [] },
    codex: {
      enabled: true,
      binary: "codex",
      sandbox: "workspace-write",
      approval_policy: "never",
      extra_args: [],
    },
    copilot: { enabled: true, binary: "copilot", extra_args: [] },
  },
  dashboard: { windowed: false, theme: "auto" },
};

function isPlainObject(value: unknown): value is RawTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively merge `override` onto `base`; arrays and scalars are replaced wholesale. */
function deepMerge(base: RawTable, override: RawTable): RawTable {
  const out: RawTable = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

function readToml(path: string | undefined): RawTable {
  if (!path || !existsSync(path)) return {};
  const parsed = parseToml(readFileSync(path, "utf8"));
  return isPlainObject(parsed) ? parsed : {};
}

function expandTilde(value: string): string {
  // Only bare `~` and `~/...` expand to the current home. Leave `~user/...`
  // (another user's home) untouched rather than wrongly rewriting it.
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function asTable(value: unknown): RawTable {
  return isPlainObject(value) ? value : {};
}

function mapGlobal(raw: RawTable): GlobalSettings {
  const g = asTable(raw.global);
  return {
    dispatcherPort: g.dispatcher_port as number,
    maxConcurrent: g.max_concurrent as number,
    defaultAdapter: g.default_adapter as string,
    logDir: expandTilde(g.log_dir as string),
    worktreeRoot: expandTilde(g.worktree_root as string),
    dbPath: expandTilde(g.db_path as string),
  };
}

function mapAdapters(raw: RawTable): Record<string, AdapterConfig> {
  const adapters = asTable(raw.adapters);
  const out: Record<string, AdapterConfig> = {};
  for (const [name, value] of Object.entries(adapters)) {
    const a = asTable(value);
    out[name] = {
      enabled: a.enabled as boolean,
      binary: a.binary as string,
      permissionMode: a.permission_mode as string | undefined,
      sandbox: a.sandbox as string | undefined,
      approvalPolicy: a.approval_policy as string | undefined,
      extraArgs: (a.extra_args as string[] | undefined) ?? [],
    };
  }
  return out;
}

function mapDashboard(raw: RawTable): DashboardSettings {
  const d = asTable(raw.dashboard);
  return { windowed: d.windowed as boolean, theme: d.theme as string };
}

function mapRepo(raw: RawTable): RepoSettings | undefined {
  if (!isPlainObject(raw.repo)) return undefined;
  const r = raw.repo;
  return {
    owner: r.owner as string,
    name: r.name as string,
    defaultBranch: r.default_branch as string,
    prMode: r.pr_mode as string,
  };
}

function mapLimits(raw: RawTable): LimitsSettings | undefined {
  if (!isPlainObject(raw.limits)) return undefined;
  const l = raw.limits;
  return {
    maxConcurrent: l.max_concurrent as number,
    maxConcurrentPerAdapter: asTable(l.max_concurrent_per_adapter) as Record<string, number>,
    complexityCeiling: l.complexity_ceiling as number,
  };
}

function mapRecommender(raw: RawTable): RecommenderSettings | undefined {
  if (!isPlainObject(raw.recommender)) return undefined;
  const r = raw.recommender;
  return {
    enabled: r.enabled as boolean,
    intervalMinutes: r.interval_minutes as number,
    adapter: r.adapter as string,
    autoDispatch: r.auto_dispatch as boolean,
    agentTimeoutMs:
      typeof r.agent_timeout_minutes === "number" ? r.agent_timeout_minutes * 60_000 : undefined,
    maxConcurrentRepos:
      typeof r.max_concurrent_repos === "number" ? r.max_concurrent_repos : undefined,
    runTimeoutMs:
      typeof r.run_timeout_seconds === "number" ? r.run_timeout_seconds * 1000 : undefined,
  };
}

function mapStateIssue(raw: RawTable): StateIssueSettings | undefined {
  if (!isPlainObject(raw.state_issue)) return undefined;
  const s = raw.state_issue;
  return { number: s.number as number, label: s.label as string };
}

function mapBootstrap(raw: RawTable): BootstrapSettings | undefined {
  if (!isPlainObject(raw.bootstrap)) return undefined;
  const b = raw.bootstrap;
  return { version: b.version as number, installedAt: b.installed_at as string };
}

function mapEpicStore(raw: RawTable): EpicStoreSettings | undefined {
  if (!isPlainObject(raw.epic_store)) return undefined;
  const e = raw.epic_store;
  // Anything other than the explicit "file" string is the github default — a
  // typo'd mode must never silently route a repo to the file store.
  const mode = e.mode === "file" ? "file" : "github";
  return {
    mode,
    epicsDir: e.epics_dir as string | undefined,
    stateFile: e.state_file as string | undefined,
  };
}

/**
 * Map the `[docs]` section. Unlike the strict per-repo mappers, the bot fields
 * default rather than trust presence — a tool/path-only override block (the
 * resolver use case) is valid without the bot keys. Override fields stay
 * `undefined` when absent so the resolver knows to auto-detect.
 */
function mapDocs(raw: RawTable): DocsSettings | undefined {
  if (!isPlainObject(raw.docs)) return undefined;
  const d = raw.docs;
  return {
    enabled: (d.enabled as boolean | undefined) ?? false,
    intervalMinutes: (d.interval_minutes as number | undefined) ?? 60,
    adapter: (d.adapter as string | undefined) ?? "claude",
    write: (d.write as boolean | undefined) ?? false,
    tool: d.tool as string | undefined,
    path: d.path as string | undefined,
  };
}

/**
 * Map the `[staleness]` section. Optional like the per-repo mappers, but its one
 * field is optional too: a bare `[staleness]` block maps to `{ specPath: undefined }`,
 * which the cron reads as "use the default spec path".
 */
function mapStaleness(raw: RawTable): StalenessSettings | undefined {
  if (!isPlainObject(raw.staleness)) return undefined;
  return { specPath: raw.staleness.spec_path as string | undefined };
}

/**
 * Load and merge the config layers into one typed object. Precedence, lowest to
 * highest: documented defaults < global file < committed repo policy
 * (`policy.toml`) < local repo cache (`config.toml`). Each layer deep-merges
 * onto the one below, so the most-local value wins on a colliding key. Missing
 * files are tolerated: an absent global file falls back to documented defaults;
 * an absent policy/local file simply contributes nothing — a fresh clone with a
 * committed `policy.toml` but no local cache yet still reads the shared policy.
 */
export function loadConfig(opts: LoadConfigOptions): MiddleConfig {
  const globalPath = opts.globalPath ?? join(homedir(), ".middle", "config.toml");
  // Committed policy lives alongside the local cache as `policy.toml` unless the
  // caller overrides it; only derived when a `repoPath` anchors the directory.
  const policyPath =
    opts.repoPolicyPath ??
    (opts.repoPath === undefined ? undefined : join(dirname(opts.repoPath), "policy.toml"));
  const globalRaw = deepMerge(GLOBAL_DEFAULTS, readToml(globalPath));
  const withPolicy = deepMerge(globalRaw, readToml(policyPath));
  const merged = deepMerge(withPolicy, readToml(opts.repoPath));

  return {
    global: mapGlobal(merged),
    adapters: mapAdapters(merged),
    dashboard: mapDashboard(merged),
    repo: mapRepo(merged),
    limits: mapLimits(merged),
    recommender: mapRecommender(merged),
    stateIssue: mapStateIssue(merged),
    epicStore: mapEpicStore(merged),
    bootstrap: mapBootstrap(merged),
    docs: mapDocs(merged),
    staleness: mapStaleness(merged),
  };
}
