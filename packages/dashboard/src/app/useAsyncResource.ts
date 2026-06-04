/**
 * A small load/error/timeout/retry state machine for a single async resource —
 * the backbone of #223's loading skeletons + inline error recovery. A consumer
 * renders a Skeleton while `status === "loading"`, the data on `"success"`, and
 * an inline error panel (with a Retry that calls `reload`) on `"error"` /
 * `"timeout"`.
 *
 * A fetch that outruns `timeoutMs` (default 10s) is aborted and surfaces the
 * distinct `"timeout"` status ("Connection lost — retrying…"), separate from a
 * server/`"error"` failure. `reload` re-runs the loader; passing `deps` re-loads
 * when they change (e.g. an SSE/poll signal), so an open panel stays fresh.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** The lifecycle of an async resource. */
export type AsyncStatus = "loading" | "success" | "error" | "timeout";

/** The resource state plus a `reload` to re-run the loader. */
export type AsyncResource<T> = {
  status: AsyncStatus;
  data?: T;
  error?: string;
  reload: () => void;
};

/** Options for {@link useAsyncResource}. */
export type AsyncResourceOptions = {
  /** Abort + surface `"timeout"` after this many ms. Default 10000. */
  timeoutMs?: number;
  /** Re-load whenever any of these change (in addition to the initial load). */
  deps?: ReadonlyArray<unknown>;
};

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Load `loader` (passing an abort signal), tracking loading/success/error/timeout. */
export function useAsyncResource<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  opts: AsyncResourceOptions = {},
): AsyncResource<T> {
  const { timeoutMs = 10_000 } = opts;
  const deps = opts.deps ?? [];
  const [state, setState] = useState<{ status: AsyncStatus; data?: T; error?: string }>({
    status: "loading",
  });

  // Keep the loader in a ref so a fresh closure each render (App passes
  // `() => api.repo(repo)`) doesn't re-trigger the load effect — only the mount
  // and an explicit `deps` change (poll/SSE signal) reload.
  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  });

  // Cancels the in-flight load (timer + late settlement). Set by each `load`,
  // invoked by the next `load` and by the unmount cleanup — a timer that fired
  // `setState` after unmount would warn and, under happy-dom, corrupt teardown.
  const cancelRef = useRef<(() => void) | null>(null);

  const load = useCallback(() => {
    cancelRef.current?.();
    setState((s) => ({ ...s, status: "loading" }));
    const controller = new AbortController();
    // `settled` guards against a late loader settlement after the timeout already
    // fired (or the resource unmounted). The timeout transitions state from its
    // OWN timer — it must NOT wait for the loader to reject on abort, because
    // loaders that ignore the signal (e.g. `api.repo`) would otherwise hang in
    // "loading" forever past the timeout.
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      setState({ status: "timeout", error: "timeout" });
    }, timeoutMs);
    cancelRef.current = () => {
      settled = true;
      clearTimeout(timer);
    };
    loaderRef
      .current(controller.signal)
      .then((data) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        setState({ status: "success", data });
      })
      .catch((e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        setState({ status: "error", error: message(e) });
      });
  }, [timeoutMs]);

  // Load on mount and whenever `deps` change (poll/SSE reload signal); cancel the
  // in-flight load on unmount / before a reload.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    load();
    return () => cancelRef.current?.();
  }, [load, ...deps]);

  return { ...state, reload: load };
}
