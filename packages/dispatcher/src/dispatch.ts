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

async function waitForSettle(engine: Engine, executionId: string): Promise<Execution | null> {
  for (;;) {
    const execution = engine.getExecution(executionId);
    if (execution && execution.state !== "running" && execution.state !== "compensating") {
      return execution;
    }
    await Bun.sleep(200);
  }
}

/**
 * Run one Epic through the Phase 1 `implementation` workflow end to end:
 * stand up a hook receiver and engine, dispatch the agent, wait for the
 * workflow to settle, then tear everything down. Self-contained — the caller
 * (`mm dispatch`) just supplies validated inputs and an adapter registry.
 */
export async function dispatchEpic(opts: DispatchEpicOptions): Promise<DispatchEpicResult> {
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  const db = openAndMigrate(opts.dbPath);
  const hookServer = new HookServer();
  hookServer.start(opts.dispatcherPort);
  const engine = new Engine({ embedded: true });

  try {
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
    hookServer.stop();
    await engine.close(true);
    db.close();
  }
}
