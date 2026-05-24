import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentAdapter } from "@middle/core";
import { Engine } from "bunqueue/workflow";
import type { Execution } from "bunqueue/workflow";
import { buildImplementationDeps } from "./build-deps.ts";
import { installBunqueueRaceSwallower } from "./bunqueue-race.ts";
import { openAndMigrate } from "./db.ts";
import { HookServer } from "./hook-server.ts";
import { DbHookStore } from "./hook-store.ts";
import { createImplementationWorkflow } from "./workflows/implementation.ts";

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

export async function waitForSettle(
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

    // The engine is referenced by `enqueueContinuation` (runtime-only) but
    // constructed AFTER the factory: `bindServer`'s `hookServer.start` is the one
    // throwable setup step (EADDRINUSE), and it must throw BEFORE the engine
    // exists so a bind failure can't leak live bunqueue workers. The `!` is safe
    // because the closure runs only at workflow runtime, long after assignment.
    let engine!: Engine;

    // Wire the deps + PR-ready gate via the shared factory. `bindServer` is the
    // HookServer-dependent slice: it stands up the SQLite-backed receiver from
    // the gate the factory built (so hooks authenticate against the per-session
    // token and flow into the events table), then hands back the live session
    // gate + its localhost dispatcherUrl (ephemeral port resolved post-start).
    const { deps } = await buildImplementationDeps({
      db,
      repoSlug: opts.repoSlug,
      getAdapter: opts.getAdapter,
      resolveRepoPath: () => opts.repoPath,
      worktreeRoot: opts.worktreeRoot,
      // Resume hand-off: a continuation round re-enters the same workflow on
      // this engine (the daemon hosts parked executions on a long-lived engine).
      enqueueContinuation: async (input) => {
        await engine.start("implementation", input);
      },
      bindServer: (prReadyGate) => {
        const hookServer = new HookServer(new DbHookStore(db), prReadyGate);
        hookServer.start(opts.dispatcherPort);
        cleanups.push(() => hookServer.stop());
        return { sessionGate: hookServer, dispatcherUrl: `http://127.0.0.1:${hookServer.port}` };
      },
    });

    engine = new Engine({ embedded: true });
    // Push the engine drain onto the cleanups stack LAST, so it pops FIRST —
    // ahead of hookServer.stop / db.close. That ordering matters two ways:
    //  - on the failure path (engine.register/start/waitForSettle throws), the
    //    engine is still drained instead of leaking live bunqueue workers;
    //  - bunqueue's executor sets exec.state='failed' BEFORE awaiting
    //    compensation, so the drain must finish (compensation included) while
    //    hookServer/db are still alive — which they are, since they pop after.
    // Capped at 10s so a hung bunqueue internal can't block the dispatch.
    cleanups.push(async () => {
      await Promise.race([
        engine.close(false).catch((err: unknown) => {
          console.error(`[dispatch] engine.close errored: ${(err as Error).message}`);
        }),
        Bun.sleep(10_000).then(() => {
          console.error(`[dispatch] engine.close drain timed out after 10s — proceeding`);
        }),
      ]);
    });

    engine.register(createImplementationWorkflow(deps));

    const handle = await engine.start("implementation", {
      repo: opts.repoSlug,
      epicNumber: opts.epicNumber,
      adapter: opts.adapterName,
    });
    console.error(`[dispatch] workflow ${handle.id} enqueued`);
    const execution = await waitForSettle(engine, handle.id);
    console.error(`[dispatch] waitForSettle returned — state=${execution?.state ?? "<null>"}`);
    // The engine drain runs in `finally` via the cleanups stack (popped first,
    // before hookServer/db), covering both success and failure paths.
    return { workflowId: handle.id, state: execution?.state ?? "failed" };
  } finally {
    await runCleanups();
  }
}
