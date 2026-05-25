/**
 * Client-side SSE subscription. The dashboard's channels emit *named* events
 * (`event: banner`, `event: workflow`, …), so a subscriber must `addEventListener`
 * per type rather than rely on the default `message` handler. This hook does
 * exactly that, keeping the handler map in a ref so it can change between renders
 * without tearing down and re-opening the `EventSource` (only `url` does that).
 *
 * `url === null` means "don't subscribe" (e.g. the Inspector is closed) — the
 * hook opens nothing and the previous stream, if any, is closed on cleanup.
 */
import { useEffect, useRef } from "react";

/** Map of SSE event names to payload handlers; each receives the JSON-decoded `data` (or `null` for a body-less frame). */
export type SseHandlers = Record<string, (data: unknown) => void>;

/**
 * Subscribe to a named-event SSE stream. Opens one `EventSource` per `url` and
 * dispatches each frame to the matching handler (always the latest handler map,
 * via a ref, so re-renders don't tear down the connection). `url === null`
 * subscribes to nothing; the only thing that re-opens the stream is a `url`
 * change or a change to the set of handled event names.
 */
export function useEventStream(url: string | null, handlers: SseHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  // The set of event names is fixed for a given mount; re-subscribing only when
  // it changes (joined into a stable key) avoids churn on every render.
  const typesKey = Object.keys(handlers).sort().join(",");

  useEffect(() => {
    if (url === null) return;
    const es = new EventSource(url);
    const types = typesKey === "" ? [] : typesKey.split(",");
    const listeners = types.map((type) => {
      const listener = (e: MessageEvent) => {
        let data: unknown = null;
        try {
          data = JSON.parse(e.data);
        } catch {
          // a frame without a JSON body — hand the handler null
        }
        handlersRef.current[type]?.(data);
      };
      es.addEventListener(type, listener);
      return { type, listener };
    });
    return () => {
      for (const { type, listener } of listeners) es.removeEventListener(type, listener);
      es.close();
    };
  }, [url, typesKey]);
}
