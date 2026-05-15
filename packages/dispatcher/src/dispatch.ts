import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentAdapter } from "@middle/core";
import { Engine } from "bunqueue/workflow";
import type { Execution } from "bunqueue/workflow";
import { openAndMigrate } from "./db.ts";
import { HookServer } from "./hook-server.ts";
import { killSession, newSession, sendEnter, sendText } from "./tmux.ts";
import { createImplementationWorkflow } from "./workflows/implementation.ts";
import { createWorktree, destroyWorktree } from "./worktree.ts";

export type DispatchEpicOptions = {
  /** Local checkout path of the repo to dispatch. */
  repoPath: string;
  /** `owner/name` — recorded on the workflow row. */
  repoSlug: string;
  /** The Epic (or standalone issue) number. */
  epicNumber: number;
  /** Configured adapter name to dispatch with. */
  adapterName: string;
  /** Adapter registry — keeps the dispatcher free of any concrete-adapter dependency. */
  getAdapter: (name: string) => AgentAdapter;
  dbPath: string;
  worktreeRoot: string;
  /** Port for the hook receiver; 0 picks an ephemeral port. */
  dispatcherPort: number;
};

export type DispatchEpicResult = {
  workflowId: string;
  /** Terminal bunqueue execution state — `completed` on success. */
  state: string;
};

/** A generous outer guard so the loop cannot spin forever if bunqueue ever
 * reports `null` for the execution (engine-state corruption). The workflow's
 * own `stopTimeoutMs` (4h default) is the intended backstop in normal flow;
 * this is the recoverable failsafe beyond it. */
const SETTLE_DEADLINE_MS = 5 * 60 * 60 * 1000;

async function waitForSettle(
  engine: Engine,
  executionId: string,
  deadlineAt: number = Date.now() + SETTLE_DEADLINE_MS,
): Promise<Execution | null> {
  for (;;) {
    const execution = engine.getExecution(executionId);
    if (execution && execution.state !== "running" && execution.state !== "compensating") {
      return execution;
    }
    if (Date.now() >= deadlineAt) return execution ?? null;
    await Bun.sleep(200);
  }
}

/**
 * bunqueue's worker can throw `Invalid or expired lock token …` from inside
 * `handleJobFailure` when the engine is shutting down concurrently with a
 * failing job — surfaces as a runtime-killing unhandledRejection. Swallow only
 * that specific message during a dispatch, and remove the listener again on
 * exit. Anything else falls through to the runtime's normal crash semantics.
 */
const BUNQUEUE_LOCK_TOKEN_RE = /Invalid or expired lock token for job/;

function installBunqueueRaceSwallower(): () => void {
  const listener = (reason: unknown): void => {
    const message = reason instanceof Error ? reason.message : String(reason);
    if (BUNQUEUE_LOCK_TOKEN_RE.test(message)) {
      console.error(`[dispatch] suppressed benign bunqueue lifecycle race: ${message}`);
      return;
    }
    // not ours — re-raise so Bun crashes the way it would have without us
    queueMicrotask(() => {
      throw reason;
    });
  };
  process.on("unhandledRejection", listener);
  return () => {
    process.off("unhandledRejection", listener);
  };
}

/**
 * Run one Epic through the Phase 1 `implementation` workflow end to end:
 * stand up a hook receiver and engine, dispatch the agent, wait for the
 * workflow to settle, then tear everything down. Self-contained — the caller
 * (`mm dispatch`) just supplies validated inputs and an adapter registry.
 *
 * Cleanup is stack-based: every acquired resource pushes its teardown onto
 * `cleanups` as soon as it is acquired. A throw anywhere — including from
 * `hookServer.start()` if the port is already bound — still runs every cleanup
 * pushed before the throw, so the db never leaks.
 */
export async function dispatchEpic(opts: DispatchEpicOptions): Promise<DispatchEpicResult> {
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

  try {
    const db = openAndMigrate(opts.dbPath);
    cleanups.push(() => db.close());

    const hookServer = new HookServer();
    hookServer.start(opts.dispatcherPort);
    cleanups.push(() => hookServer.stop());

    const engine = new Engine({ embedded: true });
    // close(false): wait for the worker to finish any in-flight job-failure
    // finalization. close(true) was racing bunqueue's `handleJobFailure` and
    // surfaced as an unhandled "Invalid or expired lock token" on repeated
    // dispatches when the workflow ended via the failure path.
    cleanups.push(() => engine.close(false));

    engine.register(
      createImplementationWorkflow({
        db,
        getAdapter: opts.getAdapter,
        sessionGate: hookServer,
        tmux: { newSession, sendText, sendEnter, killSession },
        worktree: { createWorktree, destroyWorktree },
        resolveRepoPath: () => opts.repoPath,
        worktreeRoot: opts.worktreeRoot,
        dispatcherUrl: `http://127.0.0.1:${hookServer.port}`,
      }),
    );

    const handle = await engine.start("implementation", {
      repo: opts.repoSlug,
      epicNumber: opts.epicNumber,
      adapter: opts.adapterName,
    });
    const execution = await waitForSettle(engine, handle.id);
    return { workflowId: handle.id, state: execution?.state ?? "failed" };
  } finally {
    await runCleanups();
  }
}
