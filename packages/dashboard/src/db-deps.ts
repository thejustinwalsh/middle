/**
 * The production {@link DashboardDeps} — backed by the shared SQLite db (the
 * dispatcher's operational state) plus the GitHub state issue (the recommender's
 * ranked output). Read methods project rows/state into the wire types; action
 * methods reuse the dispatcher's own mutators (`markAvailable`, the pause
 * helpers, `updateWorkflow`) so the dashboard never invents a second source of
 * truth.
 *
 * Everything that touches the world outside the db is a seam with a sensible
 * default (terminal spawn, tmux liveness, the state-issue gateway, the
 * recommender trigger, GitHub quota), so a standalone dashboard with no GitHub
 * credentials still serves live db state and degrades the rest to empty/UNKNOWN.
 */

import type { Database } from "bun:sqlite";
import type { MiddleConfig } from "@middle/core";
import { getRateLimitState, markAvailable } from "@middle/dispatcher/src/rate-limits.ts";
import {
  clearPaused,
  getPausedUntil,
  isPaused,
  setPausedUntil,
} from "@middle/dispatcher/src/repo-config.ts";
import { hasSession } from "@middle/dispatcher/src/tmux.ts";
import { updateWorkflow } from "@middle/dispatcher/src/workflow-record.ts";
import { readEpics } from "@middle/dispatcher/src/epics-cache.ts";
import { getSlotState, hasFreeSlot } from "@middle/dispatcher/src/slots.ts";
import { isParseError, type ParsedState, parseStateIssue } from "@middle/state-issue";
import { attachCommands, spawnTerminal, type TerminalSpawner } from "./attach.ts";
import type { DashboardDeps, TranscriptRead } from "./deps.ts";
import type { DashboardEventBus } from "./events.ts";
import type {
  EpicCard,
  GithubQuota,
  GlobalBanner,
  NeedsYouItem,
  RepoDetail,
  RepoSummary,
  RunnerPanel,
  RunnerSummary,
  SessionEvent,
  SettingsWire,
} from "./wire.ts";

/** A repo's read-write state issue location. */
type StateIssueGateway = {
  readBody(repo: string, issueNumber: number): Promise<string>;
};

/** Options for {@link createDbDeps}. Only `db` and `config` are required. */
export type DbDepsOptions = {
  /** The shared SQLite handle (open + migrated). */
  db: Database;
  /** The merged middle config — slot caps, default adapter, dispatcher port. */
  config: MiddleConfig;
  /** Reads a repo's state-issue body. Absent → NEXT UP / Needs-You read empty. */
  stateGateway?: StateIssueGateway;
  /** The non-terminal lifecycle states (rows holding a slot / in flight). */
  spawnTerminal?: TerminalSpawner;
  /** Probe whether a tmux session is alive. Defaults to `tmux has-session`. */
  isSessionAlive?: (session: string) => Promise<boolean>;
  /** Trigger a recommender run for a repo (the dispatcher wires this). */
  runRecommender?: (repo: string) => Promise<{ status: number; body: string }>;
  /** Best-effort GitHub API quota for the banner. Default UNKNOWN. */
  githubQuota?: () => Promise<GithubQuota>;
  /** The channel-keyed SSE bus for `/events/*`, when live. */
  events?: DashboardEventBus;
  /** Force-dispatch seam (the daemon wires it; standalone leaves it absent → 404). */
  dispatch?: (repo: string, epicNumber: number, adapter: string) => Promise<{ status: number; body: string }>;
  /** Epic-cache refresh seam (daemon-wired). */
  refreshEpicsTrigger?: (repo: string) => Promise<{ status: number; body: string }>;
};

/** The workflow columns the dashboard reads (a superset of `WorkflowRecord`). */
type WorkflowRow = {
  id: string;
  repo: string;
  epic_number: number | null;
  adapter: string;
  state: string;
  controlled_by: string;
  session_name: string | null;
  transcript_path: string | null;
  worktree_path: string | null;
  current_sub_issue: number | null;
  pr_number: number | null;
  pr_branch: string | null;
  last_heartbeat: number | null;
};

const WORKFLOW_COLUMNS =
  "id, repo, epic_number, adapter, state, controlled_by, session_name, transcript_path, worktree_path, current_sub_issue, pr_number, pr_branch, last_heartbeat";

/** Lifecycle states a workflow has finished in — excluded from "in flight". */
const TERMINAL_STATES = ["completed", "compensated", "failed", "cancelled"] as const;

/** A runner's progress string: `sub-issue m/n` when known, else the state. */
function progressOf(row: WorkflowRow): string {
  if (row.current_sub_issue !== null) return `sub-issue ${row.current_sub_issue}`;
  return row.state === "running" ? "running" : row.state;
}

/** Project a workflow row into the lighter {@link RunnerSummary}. */
function toRunnerSummary(row: WorkflowRow): RunnerSummary {
  return {
    session: row.session_name ?? row.id,
    workflowId: row.id,
    epic: row.epic_number,
    adapter: row.adapter,
    progress: progressOf(row),
    state: row.state,
    controlledBy: row.controlled_by === "human" ? "human" : "middle",
    lastHeartbeat: row.last_heartbeat,
    attachCommands: attachCommands(row.session_name ?? row.id),
  };
}

/** Build the production dashboard deps from a db handle + config + seams. */
export function createDbDeps(opts: DbDepsOptions): DashboardDeps {
  const { db, config } = opts;
  const spawn = opts.spawnTerminal ?? spawnTerminal;
  const aliveProbe = opts.isSessionAlive ?? ((session: string) => hasSession(session));

  /** Distinct repos middle tracks: every workflow repo ∪ every configured repo. */
  function repoSlugs(): string[] {
    const rows = db
      .query(
        `SELECT repo FROM workflows
         UNION
         SELECT repo FROM repo_config
         ORDER BY repo ASC`,
      )
      .all() as { repo: string }[];
    return rows.map((r) => r.repo);
  }

  /** A repo's state-issue number from `repo_config`, or null if unrecorded. */
  function stateIssueNumber(repo: string): number | null {
    const row = db.query("SELECT state_issue_number FROM repo_config WHERE repo = ?").get(repo) as {
      state_issue_number: number | null;
    } | null;
    return row?.state_issue_number ?? null;
  }

  /** Read + parse a repo's state issue; null on any failure (no gateway, parse error, GitHub error). */
  async function readParsedState(repo: string): Promise<ParsedState | null> {
    const gw = opts.stateGateway;
    const number = stateIssueNumber(repo);
    if (!gw || number === null) return null;
    try {
      const parsed = parseStateIssue(await gw.readBody(repo, number));
      return isParseError(parsed) ? null : parsed;
    } catch {
      return null;
    }
  }

  /** The per-adapter / repo-total slot caps, merged global + per-repo. */
  function repoLimits(): { perAdapter: Record<string, number>; repoMax: number } {
    return {
      perAdapter: config.limits?.maxConcurrentPerAdapter ?? {},
      repoMax: config.limits?.maxConcurrent ?? config.global.maxConcurrent,
    };
  }

  /** A repo's live per-adapter + total slot usage from the workflows table. */
  function slotUsage(repo: string): {
    adapters: RepoSummary["adapters"];
    total: RepoSummary["total"];
  } {
    const placeholders = TERMINAL_STATES.map(() => "?").join(", ");
    const byAdapter = db
      .query(
        `SELECT adapter, count(*) AS n FROM workflows
         WHERE repo = ? AND kind = 'implementation' AND state NOT IN (${placeholders})
         GROUP BY adapter`,
      )
      .all(repo, ...TERMINAL_STATES) as { adapter: string; n: number }[];
    const used: Record<string, number> = {};
    let total = 0;
    for (const r of byAdapter) {
      used[r.adapter] = r.n;
      total += r.n;
    }
    const { perAdapter, repoMax } = repoLimits();
    // Surface a pill for every capped adapter, plus any adapter currently in use
    // without a configured cap (so a running agent never vanishes from the view).
    const adapterNames = new Set<string>([...Object.keys(perAdapter), ...Object.keys(used)]);
    const adapters = [...adapterNames].sort().map((adapter) => ({
      adapter,
      used: used[adapter] ?? 0,
      max: perAdapter[adapter] ?? repoMax,
    }));
    return { adapters, total: { used: total, max: repoMax } };
  }

  function summarize(repo: string): RepoSummary {
    const { adapters, total } = slotUsage(repo);
    return { repo, adapters, total, auto: !isPaused(db, repo) };
  }

  /** Active (non-terminal) implementation runners for a repo. */
  function inFlight(repo: string): RunnerSummary[] {
    const placeholders = TERMINAL_STATES.map(() => "?").join(", ");
    const rows = db
      .query(
        `SELECT ${WORKFLOW_COLUMNS} FROM workflows
         WHERE repo = ? AND kind = 'implementation' AND state NOT IN (${placeholders})
         ORDER BY created_at ASC`,
      )
      .all(repo, ...TERMINAL_STATES) as WorkflowRow[];
    return rows.map(toRunnerSummary);
  }

  /**
   * Look up a workflow row by the session identifier the list surfaces. That id
   * is `session_name ?? id` (see {@link toRunnerSummary}), so an as-yet-unnamed
   * runner is listed under its workflow id — resolve by that same fallback here,
   * or the Inspector/attach/release lookups 404 on rows the list just returned.
   */
  function rowBySession(session: string): WorkflowRow | null {
    return db
      .query(
        `SELECT ${WORKFLOW_COLUMNS} FROM workflows
         WHERE session_name = ? OR (session_name IS NULL AND id = ?)
         LIMIT 1`,
      )
      .get(session, session) as WorkflowRow | null;
  }

  /** The non-terminal implementation workflow owning an Epic, if any. */
  function workflowForEpic(repo: string, epicNumber: number): WorkflowRow | null {
    const placeholders = TERMINAL_STATES.map(() => "?").join(", ");
    return db
      .query(
        `SELECT ${WORKFLOW_COLUMNS} FROM workflows
         WHERE repo = ? AND epic_number = ? AND kind = 'implementation' AND state NOT IN (${placeholders})
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(repo, epicNumber, ...TERMINAL_STATES) as WorkflowRow | null;
  }

  /** Slot limits for `hasFreeSlot`, from the merged config. */
  function slotLimits(): { perAdapter: Record<string, number>; repoMax: number; globalMax: number } {
    const { perAdapter, repoMax } = repoLimits();
    return { perAdapter, repoMax, globalMax: config.global.maxConcurrent };
  }

  return {
    async banner(): Promise<GlobalBanner> {
      const adapters = Object.keys(config.adapters ?? {});
      // Always include the configured adapters; UNKNOWN when never observed.
      const names = adapters.length > 0 ? adapters : ["claude", "codex"];
      const wire = names.sort().map((adapter) => {
        const state = getRateLimitState(db, adapter);
        return {
          adapter,
          status: state?.status ?? "UNKNOWN",
          resetAt: state?.resetAt ?? null,
        };
      });
      const github = opts.githubQuota
        ? await opts.githubQuota()
        : { status: "UNKNOWN" as const, remaining: null, limit: null };
      return { adapters: wire, github };
    },

    async listRepos(): Promise<RepoSummary[]> {
      return repoSlugs().map(summarize);
    },

    async getRepo(repo: string): Promise<RepoDetail | null> {
      if (!repoSlugs().includes(repo)) return null;
      const parsed = await readParsedState(repo);
      const nextUp = (parsed?.readyToDispatch ?? []).slice(0, 2).map((r) => ({
        rank: r.rank,
        epic: Number(r.epic.replace(/^#/, "")) || 0,
        adapter: r.adapter,
        subIssues: r.subIssues,
        reason: r.reason,
      }));
      return { ...summarize(repo), nextUp, inFlight: inFlight(repo) };
    },

    async listEpics(repo: string): Promise<EpicCard[]> {
      const rows = readEpics(db, repo);
      if (rows.length === 0) return [];
      const parsed = await readParsedState(repo);
      const adapters = Object.keys(config.adapters ?? {});
      // Drives the dispatch picker's per-adapter free-slot pills. Unlike the
      // banner (which lists every adapter for *observability*), this lists only
      // dispatchable adapters; with nothing configured that's `claude` alone —
      // the only wired adapter today (codex is a later phase, would 400 on dispatch).
      const adapterNames = adapters.length > 0 ? adapters : ["claude"];
      const state = getSlotState(db, repo, slotLimits());
      const freeSlots = adapterNames.sort().map((adapter) => ({
        adapter,
        available: hasFreeSlot(state, adapter),
      }));
      return rows.map((row) => {
        const wf = workflowForEpic(repo, row.number);
        const need = parsed?.needsHumanInput.find((i) => i.issue === row.number) ?? null;
        const ready = parsed?.readyToDispatch.find(
          (r) => Number(r.epic.replace(/^#/, "").split(/\s/)[0]) === row.number,
        );
        return {
          repo,
          number: row.number,
          title: row.title,
          progress: { closed: row.subClosed, total: row.subTotal },
          runner: wf
            ? {
                adapter: wf.adapter,
                state: wf.state,
                currentSubIssue: wf.current_sub_issue,
                session: wf.session_name ?? wf.id,
                prNumber: wf.pr_number,
              }
            : null,
          decision: need
            ? { label: need.label, oneLiner: need.oneLiner, ...(need.link ? { link: extractUrl(need.link) } : {}) }
            : null,
          dispatch: {
            inFlight: wf !== null,
            recommendedAdapter: ready?.adapter ?? null,
            freeSlots,
          },
        };
      });
    },

    dispatchEpic: opts.dispatch,
    refreshEpics: opts.refreshEpicsTrigger,

    async needsYou(): Promise<NeedsYouItem[]> {
      const items: NeedsYouItem[] = [];
      for (const repo of repoSlugs()) {
        const parsed = await readParsedState(repo);
        if (!parsed) continue;
        for (const item of parsed.needsHumanInput) {
          items.push({
            repo,
            issue: item.issue,
            label: item.label,
            oneLiner: item.oneLiner,
            link: item.link,
          });
        }
      }
      return items;
    },

    async getRunnerPanel(session: string): Promise<RunnerPanel | null> {
      const row = rowBySession(session);
      if (!row) return null;
      const alive = await aliveProbe(session).catch(() => false);
      return {
        session,
        workflowId: row.id,
        repo: row.repo,
        epic: row.epic_number,
        adapter: row.adapter,
        state: row.state,
        controlledBy: row.controlled_by === "human" ? "human" : "middle",
        alive,
        lastHeartbeat: row.last_heartbeat,
        contextTokens: null,
        transcriptPath: row.transcript_path,
        worktreePath: row.worktree_path,
        prNumber: row.pr_number,
        prBranch: row.pr_branch,
        currentSubIssue: row.current_sub_issue,
        attachCommands: attachCommands(session),
      };
    },

    async getSessionEvents(session: string, limit = 200): Promise<SessionEvent[] | null> {
      const row = rowBySession(session);
      if (!row) return null;
      const rows = db
        .query(
          `SELECT ts, type, payload_json FROM events
           WHERE workflow_id = ? ORDER BY ts ASC, id ASC LIMIT ?`,
        )
        .all(row.id, limit) as { ts: number; type: string; payload_json: string | null }[];
      return rows.map((r) => ({
        ts: r.ts,
        type: r.type,
        payload: r.payload_json !== null ? safeParse(r.payload_json) : null,
      }));
    },

    async getTranscript(session: string): Promise<TranscriptRead | null> {
      const row = rowBySession(session);
      if (!row?.transcript_path) return null;
      const file = Bun.file(row.transcript_path);
      if (!(await file.exists())) return null;
      return { path: row.transcript_path, stream: file.stream() };
    },

    async attach(session, mode) {
      const row = rowBySession(session);
      if (!row) return null;
      const commands = attachCommands(session);
      const command = mode === "control" ? commands.control : commands.watch;
      if (mode === "control") {
        // Flip controlled_by → human BEFORE the read-write attach so middle's
        // send-keys driving and the watchdog idle-kill are suspended first.
        updateWorkflow(db, row.id, { controlledBy: "human" });
      }
      const spawned = spawn(command);
      return {
        mode,
        command,
        spawned,
        controlledBy:
          mode === "control" ? "human" : row.controlled_by === "human" ? "human" : "middle",
      };
    },

    async release(session) {
      const row = rowBySession(session);
      if (!row) return false;
      updateWorkflow(db, row.id, { controlledBy: "middle" });
      return true;
    },

    async getSettings(): Promise<SettingsWire> {
      const repos = repoSlugs().map((repo) => {
        const until = getPausedUntil(db, repo);
        return { repo, auto: !isPaused(db, repo), pausedUntil: until };
      });
      return {
        global: {
          maxConcurrent: config.global.maxConcurrent,
          defaultAdapter: config.global.defaultAdapter,
        },
        repos,
      };
    },

    async clearRateLimit(adapter): Promise<void> {
      markAvailable(db, adapter);
    },

    async pauseRepo(repo, untilMs): Promise<void> {
      setPausedUntil(db, repo, untilMs);
    },

    async resumeRepo(repo): Promise<void> {
      clearPaused(db, repo);
    },

    async updateGlobalConfig(patch): Promise<void> {
      // The merged config is the live read model; persist into it so getSettings
      // reflects the edit. Durable file persistence is the config loader's job
      // (Phase 1) — here we mutate the in-memory merged config the server holds.
      if (patch.maxConcurrent !== undefined) config.global.maxConcurrent = patch.maxConcurrent;
      if (patch.defaultAdapter !== undefined) config.global.defaultAdapter = patch.defaultAdapter;
    },

    runRecommender: opts.runRecommender,
    events: opts.events,
  };
}

/** Parse JSON, returning the raw string if it does not parse (never throws). */
function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

/**
 * Extract a bare URL from a markdown link `[text](url)`, or return the raw
 * string unchanged when it is already a URL / doesn't match the pattern.
 */
function extractUrl(raw: string): string {
  const m = /^\[.*?\]\((.+?)\)$/.exec(raw);
  return m ? m[1]! : raw;
}
