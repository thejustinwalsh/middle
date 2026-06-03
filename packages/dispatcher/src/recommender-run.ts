import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { AgentAdapter, MiddleConfig } from "@middle/core";
import { STATE_ISSUE_SCHEMA_PATH } from "@middle/state-issue";
import { Engine } from "bunqueue/workflow";
import { installBunqueueRaceSwallower } from "./bunqueue-race.ts";
import { openAndMigrate } from "./db.ts";
import { waitForSettle } from "./engine-settle.ts";
import { HookServer } from "./hook-server.ts";
import { DbHookStore } from "./hook-store.ts";
import type { SessionGate } from "./hook-server.ts";
import { ghStateIssueGateway } from "./state-issue.ts";
import type { StateGateway } from "./state-issue.ts";
import { killSession, newSession, sendEnter, sendText } from "./tmux.ts";
import {
  buildRecommenderContext,
  createRecommenderWorkflow,
  type RecommenderContext,
  type RecommenderInput,
  type RecommenderRunConfig,
} from "./workflows/recommender.ts";
import { createWorktree, destroyWorktree } from "./worktree.ts";
import type { TmuxOps, WorktreeOps } from "./workflows/implementation.ts";

/** Slot capacity the recommender's injected `slots` reports (from config). */
export type RecommenderSlotLimits = {
  adapters: string[];
  maxPerAdapter: Record<string, number>;
  repoMax: number;
  globalMax: number;
};

/** Test seams — production omits all of these and uses the real collaborators. */
export type RecommenderRunOverrides = {
  tmux?: TmuxOps;
  worktree?: WorktreeOps;
  sessionGate?: SessionGate;
  stateIssue?: StateGateway;
  gatherContext?: (repo: string) => RecommenderContext;
  surfaceProblem?: (opts: { repo: string; stateIssue: number; problem: string }) => Promise<void>;
};

export type DispatchRecommenderOptions = {
  /** Local checkout path of the repo. */
  repoPath: string;
  /** `owner/name` — recorded on the workflow row and used by the gateways. */
  repoSlug: string;
  /** The state issue number to rewrite. */
  stateIssue: number;
  /** Adapter to run the recommender with. */
  adapterName: string;
  getAdapter: (name: string) => AgentAdapter;
  dbPath: string;
  worktreeRoot: string;
  /** Port for the hook receiver; 0 picks an ephemeral port. */
  dispatcherPort: number;
  /** On-disk path to `state-issue.v1.md` the recommender is pointed at. */
  schemaPath: string;
  /** Slot capacity reported to the recommender. */
  slots: RecommenderSlotLimits;
  /** The `config` block reported to the recommender. */
  runConfig: RecommenderRunConfig;
  /** Hard cap on the agent run (from `[recommender] agent_timeout_minutes`); undefined → workflow default. */
  agentTimeoutMs?: number;
  /**
   * The auto-dispatch seam (Phase 8). When wired, the recommender workflow fires
   * it after a clean run (gated additionally on `runConfig.autoDispatch`) — the
   * "recommender run completes" trigger. Left undefined keeps the Phase 7
   * read-only behaviour (nothing auto-dispatches).
   */
  triggerAutoDispatch?: (opts: { repo: string; stateIssue: number }) => Promise<void>;
  /** Test seams; production passes none. */
  overrides?: RecommenderRunOverrides;
};

export type DispatchRecommenderResult = {
  workflowId: string;
  /** Terminal bunqueue execution state — `completed` on success. */
  state: string;
};

/** The resolved options ready for `dispatchRecommender`, or a human-readable error. */
export type ResolveRecommenderResult =
  | { ok: true; options: Omit<DispatchRecommenderOptions, "overrides"> }
  | { ok: false; error: string };

/** Derive an `owner/name` slug from the repo's `origin` remote, falling back to its dir name. */
async function deriveRepoSlug(repoPath: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repoPath, "remote", "get-url", "origin"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const url = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) === 0 && url) {
    const match = /[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
    if (match) return match[1]!;
  }
  return basename(repoPath);
}

/**
 * Validate a repo + its config and assemble `dispatchRecommender` options.
 * Shared by the `mm run-recommender` CLI and the dispatcher's dashboard trigger
 * so both resolve state issue, adapter, schema path, slots, and run-config the
 * same way. Errors are generic (no command prefix) so each caller can frame them.
 */
export async function resolveRecommenderOptions(
  repoPath: string,
  config: MiddleConfig,
  getAdapter: (name: string) => AgentAdapter,
): Promise<ResolveRecommenderResult> {
  const stateIssue = config.stateIssue?.number;
  if (stateIssue === undefined) {
    return { ok: false, error: `no state issue configured for this repo (run \`mm init\` first)` };
  }
  const adapterName = config.recommender?.adapter ?? config.global.defaultAdapter;
  try {
    getAdapter(adapterName);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  // Dispatchable = implemented (above) AND enabled in config — mirror the
  // daemon's manual-dispatch gate so a `[recommender] adapter = "x"` pointing
  // at a disabled adapter can't sneak through the `/trigger/recommender`
  // entry point (the CLI gates earlier, the dashboard hits this directly).
  if (!(config.adapters[adapterName]?.enabled ?? false)) {
    return { ok: false, error: `adapter ${adapterName} is disabled in config` };
  }
  // Resolved from the middle installation, NOT from repoPath — the schema is the
  // single source of truth and is not stamped into target repos (issue #107).
  const schemaPath = STATE_ISSUE_SCHEMA_PATH;
  if (!existsSync(schemaPath)) {
    return {
      ok: false,
      error: `state-issue schema missing from the middle installation at ${schemaPath} — this is a packaging bug, not a repo problem`,
    };
  }
  const repoSlug = await deriveRepoSlug(repoPath);
  return {
    ok: true,
    options: {
      repoPath,
      repoSlug,
      stateIssue,
      adapterName,
      getAdapter,
      dbPath: config.global.dbPath,
      worktreeRoot: config.global.worktreeRoot,
      dispatcherPort: config.global.dispatcherPort,
      schemaPath,
      slots: {
        adapters: Object.keys(config.adapters),
        maxPerAdapter: config.limits?.maxConcurrentPerAdapter ?? {},
        repoMax: config.limits?.maxConcurrent ?? config.global.maxConcurrent,
        globalMax: config.global.maxConcurrent,
      },
      runConfig: {
        defaultAdapter: config.global.defaultAdapter,
        autoDispatch: config.recommender?.autoDispatch ?? false,
        prMode: config.repo?.prMode ?? "worktree",
      },
      agentTimeoutMs: config.recommender?.agentTimeoutMs,
    },
  };
}

/** Default human surface: comment the problem on the state issue via `gh`. */
export async function ghSurfaceProblem(opts: {
  repo: string;
  stateIssue: number;
  problem: string;
}): Promise<void> {
  const proc = Bun.spawn(
    [
      "gh",
      "issue",
      "comment",
      String(opts.stateIssue),
      "--repo",
      opts.repo,
      "--body",
      opts.problem,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  if ((await proc.exited) !== 0) {
    throw new Error(`gh issue comment failed: ${(await new Response(proc.stderr).text()).trim()}`);
  }
}

/**
 * Run one recommender pass end to end: stand up a hook receiver and engine,
 * spawn the recommender agent in its own dedicated slot, wait for the workflow
 * to settle, then tear everything down. Uses a stack-based cleanup (every
 * acquired resource pushes its teardown as it's acquired); the recommender is
 * an ephemeral, self-contained engine — distinct from the daemon-hosted
 * implementation workflow. It is read-only in Phase 7 — `triggerAutoDispatch` is
 * deliberately left UNWIRED, so a clean run rewrites the state issue but
 * dispatches nothing.
 *
 * Test seams (`overrides`) let a test drive it against stubs (no tmux/gh); the
 * sessionGate override skips the real hook server.
 */
export async function dispatchRecommender(
  opts: DispatchRecommenderOptions,
): Promise<DispatchRecommenderResult> {
  mkdirSync(dirname(opts.dbPath), { recursive: true });

  const cleanups: Array<() => Promise<void> | void> = [];
  cleanups.push(installBunqueueRaceSwallower());
  const runCleanups = async (): Promise<void> => {
    while (cleanups.length > 0) {
      try {
        await cleanups.pop()!();
      } catch {
        // best-effort: one failing teardown must not block the rest
      }
    }
  };

  const ov = opts.overrides ?? {};
  try {
    const db = openAndMigrate(opts.dbPath);
    cleanups.push(() => db.close());

    // The real hook server is only needed when no sessionGate stub is injected.
    let sessionGate: SessionGate;
    let dispatcherUrl = `http://127.0.0.1:${opts.dispatcherPort}`;
    if (ov.sessionGate) {
      sessionGate = ov.sessionGate;
    } else {
      const hookServer = new HookServer(new DbHookStore(db));
      hookServer.start(opts.dispatcherPort);
      cleanups.push(() => hookServer.stop());
      sessionGate = hookServer;
      dispatcherUrl = `http://127.0.0.1:${hookServer.port}`;
    }

    const engine = new Engine({ embedded: true });
    cleanups.push(async () => {
      await Promise.race([
        engine.close(false).catch((err: unknown) => {
          console.error(`[recommender-run] engine.close errored: ${(err as Error).message}`);
        }),
        Bun.sleep(10_000).then(() => {
          console.error(`[recommender-run] engine.close drain timed out after 10s — proceeding`);
        }),
      ]);
    });

    const gatherContext =
      ov.gatherContext ??
      ((repo: string): RecommenderContext =>
        buildRecommenderContext({
          db,
          repo,
          adapters: opts.slots.adapters,
          maxPerAdapter: opts.slots.maxPerAdapter,
          repoMax: opts.slots.repoMax,
          globalMax: opts.slots.globalMax,
        }));

    engine.register(
      createRecommenderWorkflow({
        db,
        getAdapter: opts.getAdapter,
        sessionGate,
        tmux: ov.tmux ?? { newSession, sendText, sendEnter, killSession },
        worktree: ov.worktree ?? { createWorktree, destroyWorktree },
        resolveRepoPath: () => opts.repoPath,
        worktreeRoot: opts.worktreeRoot,
        dispatcherUrl,
        schemaPath: opts.schemaPath,
        stateIssue: ov.stateIssue ?? ghStateIssueGateway,
        repoConfig: { adapters: opts.slots.adapters },
        config: opts.runConfig,
        agentTimeoutMs: opts.agentTimeoutMs,
        gatherContext,
        surfaceProblem: ov.surfaceProblem ?? ghSurfaceProblem,
        // Phase 8: when the caller wires it (the daemon does), the workflow's
        // trigger-auto-dispatch step fires it on a clean run with auto_dispatch on.
        triggerAutoDispatch: opts.triggerAutoDispatch,
      }),
    );

    const input: RecommenderInput = {
      repo: opts.repoSlug,
      stateIssue: opts.stateIssue,
      adapter: opts.adapterName,
    };
    const handle = await engine.start("recommender", input);
    console.error(`[recommender-run] workflow ${handle.id} enqueued`);
    const execution = await waitForSettle(engine, handle.id);
    return { workflowId: handle.id, state: execution?.state ?? "failed" };
  } finally {
    await runCleanups();
  }
}
