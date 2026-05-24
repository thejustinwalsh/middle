import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { AgentAdapter, MiddleConfig } from "@middle/core";
import { resolveDocsTarget } from "@middle/docs";
import { Engine } from "bunqueue/workflow";
import { openAndMigrate } from "./db.ts";
import { installBunqueueRaceSwallower, waitForSettle } from "./dispatch.ts";
import { HookServer } from "./hook-server.ts";
import { DbHookStore } from "./hook-store.ts";
import type { SessionGate } from "./hook-server.ts";
import { killSession, newSession, sendEnter, sendText } from "./tmux.ts";
import {
  createDocumentationWorkflow,
  type DocsTargetSummary,
  type DocumentationInput,
  type DocumentationRunConfig,
} from "./workflows/documentation.ts";
import { createWorktree, destroyWorktree } from "./worktree.ts";
import type { TmuxOps, WorktreeOps } from "./workflows/implementation.ts";

/** Test seams — production omits all of these and uses the real collaborators. */
export type DocumentationRunOverrides = {
  tmux?: TmuxOps;
  worktree?: WorktreeOps;
  sessionGate?: SessionGate;
};

export type DispatchDocumentationOptions = {
  /** Local checkout path of the repo. */
  repoPath: string;
  /** `owner/name` — recorded on the workflow row and used by the gateways. */
  repoSlug: string;
  /** Adapter to run the docs bot with. */
  adapterName: string;
  getAdapter: (name: string) => AgentAdapter;
  dbPath: string;
  worktreeRoot: string;
  /** Port for the hook receiver; 0 picks an ephemeral port. */
  dispatcherPort: number;
  /** The resolved docs target, reported to the docs agent. */
  target: DocsTargetSummary;
  /** The `config` block reported to the docs agent. */
  runConfig: DocumentationRunConfig;
  /** Test seams; production passes none. */
  overrides?: DocumentationRunOverrides;
};

export type DispatchDocumentationResult = {
  workflowId: string;
  /** Terminal bunqueue execution state — `completed` on success. */
  state: string;
};

/** The resolved options ready for `dispatchDocumentation`, or a human-readable error. */
export type ResolveDocumentationResult =
  | { ok: true; options: Omit<DispatchDocumentationOptions, "overrides"> }
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
 * Validate a repo + its config and assemble `dispatchDocumentation` options.
 * Resolves the docs target through `@middle/docs` (honoring any `[docs]`
 * override) and reports it to the agent. Errors are generic (no command prefix)
 * so each caller can frame them.
 */
export async function resolveDocumentationOptions(
  repoPath: string,
  config: MiddleConfig,
  getAdapter: (name: string) => AgentAdapter,
): Promise<ResolveDocumentationResult> {
  const adapterName = config.docs?.adapter ?? config.global.defaultAdapter;
  if (adapterName !== "claude") {
    return {
      ok: false,
      error: `only the 'claude' adapter is available in Phase 1 (config asks for "${adapterName}")`,
    };
  }

  let target: DocsTargetSummary;
  try {
    const resolved = resolveDocsTarget(repoPath, config.docs);
    target = { name: resolved.name, docsRoot: resolved.docsRoot, supportsLlmsTxt: resolved.supportsLlmsTxt };
  } catch (error) {
    // An unknown `[docs] tool` is a config error — surface it, don't fall back.
    return { ok: false, error: (error as Error).message };
  }

  const repoSlug = await deriveRepoSlug(repoPath);
  return {
    ok: true,
    options: {
      repoPath,
      repoSlug,
      adapterName,
      getAdapter,
      dbPath: config.global.dbPath,
      worktreeRoot: config.global.worktreeRoot,
      dispatcherPort: config.global.dispatcherPort,
      target,
      runConfig: {
        defaultAdapter: config.global.defaultAdapter,
        write: config.docs?.write ?? false,
      },
    },
  };
}

/**
 * Run one documentation pass end to end: stand up a hook receiver and engine,
 * spawn the docs agent in its own dedicated slot, wait for the workflow to
 * settle, then tear everything down. Mirrors `dispatchRecommender`'s stack-based
 * cleanup. Read-only/dry-run first — the `persistDocs` write seam is left
 * UNWIRED, so a clean run audits the docs surface but persists nothing.
 *
 * Test seams (`overrides`) let a test drive it against stubs (no tmux/gh); the
 * sessionGate override skips the real hook server.
 */
export async function dispatchDocumentation(
  opts: DispatchDocumentationOptions,
): Promise<DispatchDocumentationResult> {
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
          console.error(`[documentation-run] engine.close errored: ${(err as Error).message}`);
        }),
        Bun.sleep(10_000).then(() => {
          console.error(`[documentation-run] engine.close drain timed out after 10s — proceeding`);
        }),
      ]);
    });

    engine.register(
      createDocumentationWorkflow({
        db,
        getAdapter: opts.getAdapter,
        sessionGate,
        tmux: ov.tmux ?? { newSession, sendText, sendEnter, killSession },
        worktree: ov.worktree ?? { createWorktree, destroyWorktree },
        resolveRepoPath: () => opts.repoPath,
        worktreeRoot: opts.worktreeRoot,
        dispatcherUrl,
        target: opts.target,
        config: opts.runConfig,
        // Read-only/dry-run first: persistDocs intentionally UNWIRED.
      }),
    );

    const input: DocumentationInput = { repo: opts.repoSlug, adapter: opts.adapterName };
    const handle = await engine.start("documentation", input);
    console.error(`[documentation-run] workflow ${handle.id} enqueued`);
    const execution = await waitForSettle(engine, handle.id);
    return { workflowId: handle.id, state: execution?.state ?? "failed" };
  } finally {
    await runCleanups();
  }
}
