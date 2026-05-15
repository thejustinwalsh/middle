import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
};

export type StateIssueSettings = {
  number: number;
  label: string;
};

export type BootstrapSettings = {
  version: number;
  installedAt: string;
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
  bootstrap?: BootstrapSettings;
};

export type LoadConfigOptions = {
  /** Path to the global config; defaults to `~/.middle/config.toml`. */
  globalPath?: string;
  /** Path to the per-repo config (`<repo>/.middle/config.toml`); optional. */
  repoPath?: string;
};

type RawTable = Record<string, unknown>;

/** Documented defaults from the build spec's "Global config" block. */
const GLOBAL_DEFAULTS: RawTable = {
  global: {
    dispatcher_port: 8822,
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
    out[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

function readToml(path: string | undefined): RawTable {
  if (!path || !existsSync(path)) return {};
  const parsed = parseToml(readFileSync(path, "utf8"));
  return isPlainObject(parsed) ? parsed : {};
}

function expandTilde(value: string): string {
  return value.startsWith("~") ? join(homedir(), value.slice(1)) : value;
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

/**
 * Load and merge the global and per-repo config files into one typed object.
 * Per-repo values override global on any colliding key (deep merge). Missing
 * files are tolerated: an absent global file falls back to documented defaults,
 * an absent per-repo file leaves the per-repo sections undefined.
 */
export function loadConfig(opts: LoadConfigOptions): MiddleConfig {
  const globalPath = opts.globalPath ?? join(homedir(), ".middle", "config.toml");
  const globalRaw = deepMerge(GLOBAL_DEFAULTS, readToml(globalPath));
  const merged = deepMerge(globalRaw, readToml(opts.repoPath));

  return {
    global: mapGlobal(merged),
    adapters: mapAdapters(merged),
    dashboard: mapDashboard(merged),
    repo: mapRepo(merged),
    limits: mapLimits(merged),
    recommender: mapRecommender(merged),
    stateIssue: mapStateIssue(merged),
    bootstrap: mapBootstrap(merged),
  };
}
