import type { Database } from "bun:sqlite";
import { Queue } from "bunqueue/client";
import { Engine } from "bunqueue/workflow";
import {
  consumeWaitForSignal,
  finalizeParkedWorkflow,
  loadPollableWaits,
  recordEvent,
  type TerminalWorkflowState,
} from "./workflow-record.ts";

/**
 * Construct the daemon's durable workflow engine: a persistent execution **store**
 * (`dataPath`, a SQLite db) with a **transient** in-process step queue.
 *
 * bunqueue's embedded queue + worker route through one process-singleton manager
 * keyed by the FIRST `dataPath` set in the process. We claim that singleton as
 * in-memory (a throwaway `Queue` with no `dataPath`) BEFORE constructing the Engine,
 * so the Engine's `WorkflowStore` persists (it opens `dataPath` directly, independent
 * of the manager) while its step queue stays in-memory. This is deliberate: a
 * **persistent** queue replays stale step jobs onto the fresh worker after a restart —
 * re-driving `launch-and-drive` and double-launching a tmux session the restart left
 * alive. The durable store is the source of truth; `recoverEngine` rebuilds the queue
 * from it on boot. See this package's CLAUDE.md ("bunqueue lifecycle").
 *
 * Guarded: if any of these env vars is set, the throwaway `Queue`'s shared manager would
 * resolve a *persistent* `dataPath` from it (bunqueue's `getDataPath()` reads them with
 * `??`), making the queue persistent and defeating the whole design — so we throw rather
 * than silently build it. middle never sets these; the guard stops a parent-process env
 * injection from doing it for us.
 */
const PERSISTENT_QUEUE_ENV_VARS = [
  "BUNQUEUE_DATA_PATH",
  "BQ_DATA_PATH",
  "DATA_PATH",
  "SQLITE_PATH",
] as const;

export function createDurableEngine(dataPath: string): Engine {
  // bunqueue's `getDataPath()` coalesces these with `??`, so any value that isn't strictly
  // `undefined` (including `""`) becomes the manager's dataPath — match that exactly.
  const persistent = PERSISTENT_QUEUE_ENV_VARS.filter((name) => process.env[name] !== undefined);
  if (persistent.length > 0) {
    const plural = persistent.length > 1;
    throw new Error(
      `createDurableEngine requires an in-memory bunqueue queue, but ${persistent.join(", ")} ` +
        `${plural ? "are" : "is"} set; a persistent queue replays stale step jobs onto the fresh ` +
        `worker after a restart (double-launching a session). Unset ${plural ? "them" : "it"} first.`,
    );
  }
  new Queue("__mm:engine-queue", { embedded: true });
  return new Engine({ embedded: true, dataPath });
}

/**
 * bunqueue execution states `engine.recover()` would re-drive that #116 deliberately
 * leaves to the watchdog: a `running` exec is re-enqueued at its current step and a
 * `compensating` one re-runs compensation. Re-driving a mid-drive dispatch would launch
 * a SECOND tmux session alongside the live one (a daemon restart does not kill the
 * agent's sessions — they aren't daemon children), so we drop these before recover()
 * and let the watchdog reconcile their `launching`/`running` rows on its first tick.
 */
const MID_DRIVE_STATES = ["running", "compensating"] as const;

/** What {@link recoverEngine} did on boot. */
export type EngineRecoveryResult = {
  /** Mid-drive (`running`/`compensating`) executions dropped before recover(). */
  cleared: number;
  /** bunqueue's `recover()` tally (parked `waiting` re-armed, signals resumed, …). */
  recovered: Awaited<ReturnType<Engine["recover"]>>;
};

/**
 * Recover the daemon's persistent workflow engine on boot. Drops mid-drive
 * (`running`/`compensating`) executions — their recovery is the watchdog's domain
 * (#116 out of scope; see {@link MID_DRIVE_STATES}) — then runs `engine.recover()` so
 * parked `waiting` executions have their `waitFor` timeout timers re-armed (and any whose
 * resume signal arrived while the daemon was down are resumed). `engine.cleanup(0, …)`
 * deletes execs whose `updated_at` predates this boot, i.e. every pre-restart row.
 *
 * Must run AFTER the workflows are registered (recover may re-enqueue/resume, which
 * needs the workflow definition) and BEFORE the poller starts (so it never fires a
 * resume at an exec recover hasn't re-armed yet).
 *
 * When `db` is supplied, writes a `daemon.recovered` event for each `waiting-human`
 * workflow that survives the restart, giving the Inspector an audit trail of the
 * recovery (#260). Callers that don't supply `db` (e.g. tests using a plain
 * `new Engine(...)` without a middle DB) continue to work unchanged.
 */
export async function recoverEngine(engine: Engine, db?: Database): Promise<EngineRecoveryResult> {
  const cleared = engine.cleanup(0, [...MID_DRIVE_STATES]);
  // Snapshot the waiting-human workflows BEFORE recover() so we know which ones
  // survived the restart and were eligible for re-arm. `loadPollableWaits` returns
  // only workflows in `waiting-human` state with an armed `waitfor_signals` row.
  const waitingBefore = db ? loadPollableWaits(db) : [];
  const recovered = await engine.recover();
  // Record a daemon.recovered event for each waiting-human workflow so the Inspector
  // timeline shows the restart boundary. Best-effort: a recording failure must not
  // prevent the daemon from booting.
  if (db && waitingBefore.length > 0) {
    const now = Date.now();
    for (const wait of waitingBefore) {
      try {
        recordEvent(db, {
          workflowId: wait.workflowId,
          ts: now,
          type: "daemon.recovered",
          payloadJson: JSON.stringify({ workflowId: wait.workflowId }),
        });
      } catch (err) {
        console.error(
          `[recover] recording daemon.recovered for ${wait.workflowId} failed: ${(err as Error).message}`,
        );
      }
    }
  }
  return { cleared, recovered };
}

/** A parked workflow whose durable signal armed but whose engine execution is gone. */
export type OrphanedSignal = {
  workflowId: string;
  repo: string;
  epicRef: string | null;
  signalName: string;
};

/** Inputs for {@link reconcileOrphanedSignals}. */
export type ReconcileOrphanedSignalsDeps = {
  db: Database;
  /**
   * Whether the engine still has a recoverable execution for this workflow id — in
   * production `(id) => engine.getExecution(id) !== null`. A null execution is the
   * orphan: the durable store never had it (a park from before persistence shipped, or
   * a wiped queue db), so `engine.signal` against it throws `Execution "<id>" not found`.
   */
  hasExecution: (workflowId: string) => boolean;
  /** Best-effort surface of an orphan for human visibility (log/Epic comment). Optional. */
  surface?: (orphan: OrphanedSignal) => void | Promise<void>;
  /** Terminal state an orphan is finalized to. Defaults to `"failed"`. */
  finalState?: TerminalWorkflowState;
};

/**
 * Reconcile orphaned parked signals on boot, AFTER {@link recoverEngine}. An armed
 * `waitfor_signals` row on a `waiting-human` workflow with no recoverable execution
 * (`hasExecution` false) can never be resumed — and the poller would otherwise fire
 * `engine.signal` at the dead execution every pass forever. Each orphan is finalized to
 * a terminal state (conditionally — never clobbering a row a concurrent path advanced),
 * its signal row consumed so the poller stops watching it, and surfaced for a human.
 * Returns the orphans it reconciled.
 */
export async function reconcileOrphanedSignals(
  deps: ReconcileOrphanedSignalsDeps,
): Promise<OrphanedSignal[]> {
  const finalState = deps.finalState ?? "failed";
  const orphans: OrphanedSignal[] = [];
  for (const wait of loadPollableWaits(deps.db)) {
    if (deps.hasExecution(wait.workflowId)) continue;
    // Finalize FIRST, conditionally: `finalizeParkedWorkflow` only writes if the row is
    // still `waiting-human`, so a row another path already advanced is skipped (false).
    if (!finalizeParkedWorkflow(deps.db, wait.workflowId, finalState)) continue;
    consumeWaitForSignal(deps.db, wait.workflowId);
    // Record the orphan finalization so the Inspector timeline shows the audit trail.
    try {
      recordEvent(deps.db, {
        workflowId: wait.workflowId,
        ts: Date.now(),
        type: "daemon.orphan-finalized",
        payloadJson: JSON.stringify({ finalState }),
      });
    } catch (err) {
      console.error(
        `[recover] recording daemon.orphan-finalized for ${wait.workflowId} failed: ${(err as Error).message}`,
      );
    }
    const orphan: OrphanedSignal = {
      workflowId: wait.workflowId,
      repo: wait.repo,
      epicRef: wait.epicRef,
      signalName: wait.signalName,
    };
    orphans.push(orphan);
    if (deps.surface) {
      try {
        await deps.surface(orphan);
      } catch (error) {
        console.error(
          `[recover] surfacing orphaned signal ${wait.workflowId} (${wait.signalName}) failed: ${(error as Error).message}`,
        );
      }
    }
  }
  return orphans;
}
