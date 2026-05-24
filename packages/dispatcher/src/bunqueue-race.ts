/**
 * bunqueue's worker can throw `Invalid or expired lock token …` from inside
 * `handleJobFailure` when the engine is shutting down concurrently with a
 * failing job — it surfaces as a runtime-killing unhandledRejection. Swallow
 * only that specific message, and remove the listener again on teardown.
 * Anything else falls through to the runtime's normal crash semantics.
 *
 * Installed for the duration of a process that drives a bunqueue engine: the
 * daemon (`main.ts`) for its lifetime, and the ephemeral recommender run
 * (`recommender-run.ts`). See this package's CLAUDE.md — do NOT broaden the match.
 */
const BUNQUEUE_LOCK_TOKEN_RE = /Invalid or expired lock token for job/;

export function installBunqueueRaceSwallower(): () => void {
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
