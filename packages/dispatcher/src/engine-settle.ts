import type { Engine, Execution } from "bunqueue/workflow";

/**
 * A generous outer guard so a settle-poll cannot spin forever if bunqueue ever
 * reports `null` for the execution (engine-state corruption). A workflow's own
 * `stopTimeoutMs` is the intended backstop in normal flow; this is the
 * recoverable failsafe beyond it.
 */
const SETTLE_DEADLINE_MS = 5 * 60 * 60 * 1000;

/**
 * Poll a bunqueue execution until it leaves the `running`/`compensating` states
 * (i.e. settles to `completed`/`failed`/`waiting`/`compensated`), or the
 * deadline passes. Returns the final execution, or `null` if it never appears.
 *
 * Used by the ephemeral recommender run (`recommender-run.ts`), which owns its
 * own short-lived engine and waits synchronously for the run to finish. The
 * implementation dispatch path does NOT use this — it parks on the daemon's
 * long-lived engine and is resumed by the poller, never torn down on settle.
 */
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
