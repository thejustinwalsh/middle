/**
 * The dashboard's uniform async-error funnel. Every API call the SPA fires is
 * invoked fire-and-forget — `void f()` from an effect/interval, or straight from
 * an onClick whose returned promise React drops — so an uncaught rejection would
 * be an unhandled rejection *and* never reach the error bar. `guard` makes the
 * failure mode uniform: surface it on the bar, clear it on the next success of
 * the *same source*.
 *
 * Errors are keyed by `source` because the dashboard runs concurrent pollers
 * (the top refresh + the settings refresh). A success only clears *its own*
 * source's error, so a healthy top poll can't wipe out a live settings failure
 * (which would otherwise flicker the bar on every tick).
 *
 * Composition gotcha: a guarded op that wants to run a sub-step must `await` the
 * sub-step's *raw* work, never a second `guard(sameSource, …)`. A nested
 * same-source guard swallows the inner failure, and then the outer guard's
 * success path clears it — so the error never shows. See `App`'s `loadInspector`
 * (raw, awaited by `takeControl`/`release`) vs `openInspector` (guarded wrapper).
 */
import type { Dispatch, SetStateAction } from "react";

/** A surfaced API error tagged with the `source` that raised it, so a success on one source can't clear another source's error. */
export type GuardError = { source: string; message: string };

/** Runs `work` under `source`: clears `source`'s error on success, surfaces `{ source, message }` on failure. Never throws. */
export type Guard = (source: string, work: () => Promise<void>) => Promise<void>;

/**
 * Build a {@link Guard} bound to a React `setError` setter. The returned runner
 * awaits `work`; on success it clears only `source`'s error (any other source's
 * error is left intact), on rejection it sets `{ source, message }`. It never
 * rejects, so callers can invoke it fire-and-forget.
 */
export function makeGuard(setError: Dispatch<SetStateAction<GuardError | null>>): Guard {
  return async (source, work) => {
    try {
      await work();
      setError((cur) => (cur?.source === source ? null : cur));
    } catch (e) {
      setError({ source, message: e instanceof Error ? e.message : String(e) });
    }
  };
}
