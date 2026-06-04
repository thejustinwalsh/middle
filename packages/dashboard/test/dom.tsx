/**
 * Real-DOM test scaffolding (happy-dom) for the component/interaction tests that
 * the SSR (`renderToStaticMarkup`) path can't cover: Radix portals (Sheet, Select
 * content) only mount into a live `document.body`, focus/`:focus-visible` and
 * `matchMedia`-driven responsive behavior need a DOM, and the error-recovery flow
 * needs mockable async.
 *
 * happy-dom is registered ONCE per process (`registerDom` is idempotent; there is
 * no unregister). `@happy-dom/global-registrator` is NOT safe to
 * register/unregister-cycle — doing so across several DOM test files corrupts its
 * DOM tree (React unmount throws `removeChild` DOMExceptions) and degrades its
 * timers. Registering once is stable.
 *
 * To keep the rest of the `bun test` run unaffected, after registering we RESTORE
 * every native web primitive the (happy-dom-free) live-server tests rely on —
 * `fetch`/`Response`/`Request`/streams/timers/etc. The two worlds are disjoint:
 * DOM tests use `document`/`window` (kept from happy-dom) and never `fetch`;
 * live-server tests use `fetch`/`Response`/`Bun.serve` and never the DOM. No
 * non-dashboard test touches `window`/`document`, so one global registration is
 * safe for the whole run.
 *
 * DOM test files must import the components under test DYNAMICALLY inside
 * `beforeAll` (after {@link registerDom}) — a Radix primitive imported before
 * happy-dom registers binds to a doc-less global and won't mount its portal. See
 * `inspector.test.tsx`.
 */
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Native web primitives the live-server / streaming / timer tests need, captured
// before happy-dom can replace them and restored right after registration.
const NATIVE_GLOBALS = [
  "fetch",
  "Response",
  "Request",
  "Headers",
  "FormData",
  "Blob",
  "File",
  "URL",
  "URLSearchParams",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "TextEncoder",
  "TextDecoder",
  "AbortController",
  "AbortSignal",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "queueMicrotask",
  "crypto",
  "performance",
  "WebSocket",
  "EventSource",
] as const;
const natives = new Map<string, unknown>(
  NATIVE_GLOBALS.map((k) => [k, (globalThis as Record<string, unknown>)[k]]),
);

let registered = false;

/** Register happy-dom once (idempotent) + React's act env, restoring native web primitives. */
export function registerDom(): void {
  if (!registered) {
    GlobalRegistrator.register();
    for (const [k, v] of natives) {
      if (v !== undefined) (globalThis as Record<string, unknown>)[k] = v;
    }
    registered = true;
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

/** No-op: happy-dom stays registered for the process (see the module header). */
export function unregisterDom(): void {}

/** A mounted render: the container, the React root, and an async unmount. */
export type Mounted = {
  container: HTMLElement;
  root: Root;
  unmount: () => Promise<void>;
};

/** Mount a React element into a fresh container appended to `document.body`. */
export async function renderDom(node: ReactElement): Promise<Mounted> {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return {
    container,
    root,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** Run a callback inside `act` and let microtasks/effects flush. */
export async function flush(fn: () => void | Promise<void> = () => {}): Promise<void> {
  const { act } = await import("react");
  await act(async () => {
    await fn();
  });
}
