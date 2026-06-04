/**
 * Real-DOM test scaffolding (happy-dom) for the component/interaction tests that
 * the SSR (`renderToStaticMarkup`) path can't cover: Radix portals (Sheet, Select
 * content) only mount into a live `document.body`, focus/`:focus-visible` and
 * `matchMedia`-driven responsive behavior need a DOM, and the error-recovery flow
 * needs a mockable `fetch`.
 *
 * happy-dom is registered PER FILE (call {@link registerDom}/{@link unregisterDom}
 * in `beforeAll`/`afterAll`), never globally — its `fetch` replacement can't talk
 * to a live `Bun.serve`, so the live-server tests (`app.test.tsx`, `spa.test.ts`,
 * `scaffold.test.tsx`) deliberately stay happy-dom-free and use native `fetch`.
 *
 * `react-dom/client` and React's `act` are imported LAZILY inside the helpers, not
 * at module top: a test file imports this module before its `beforeAll` runs, and
 * `react-dom/client` must bind to globals only AFTER happy-dom has registered
 * `document`/`window` — a top-level import binds too early and renders into a void.
 *
 * For the SAME reason, DOM test files must import the components under test
 * DYNAMICALLY inside `beforeAll` (after {@link registerDom}), never statically at
 * module top — Radix primitives (Dialog/Select portals) imported before happy-dom
 * registers won't mount their portals. See `inspector.test.tsx` for the pattern.
 */
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/** Register happy-dom globals + React's act environment. Call in `beforeAll`. */
export function registerDom(): void {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

/** Tear down the happy-dom globals. Call in `afterAll`. */
export async function unregisterDom(): Promise<void> {
  await GlobalRegistrator.unregister();
}

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
