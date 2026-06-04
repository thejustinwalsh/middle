/**
 * Regression for the stale live-queue bug (CodeRabbit, PR #231): `queueLive`
 * accumulates `/control/events` frames only while the Queue view is mounted, so
 * leaving and re-entering the view must start from an empty set — otherwise a
 * workflow that transitioned away while we were unsubscribed lingers as a stale
 * row (and re-merges with new frames).
 *
 * Drives the *real* `<App/>` in happy-dom with a fake `EventSource` (to inject
 * frames deterministically) and a minimal `fetch` router (so the view's metrics
 * snapshot is present and the table renders). `.tsx` (renders JSX); runs under
 * `bun test packages/dashboard/`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { flush, registerDom, renderDom, unregisterDom } from "./dom.tsx";

let App: (typeof import("../src/app/App.tsx"))["App"];

/** A controllable EventSource: records instances and lets a test emit named frames. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  private listeners = new Map<string, (e: { data: string }) => void>();
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (e: { data: string }) => void): void {
    this.listeners.set(type, cb);
  }
  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }
  close(): void {
    this.readyState = 2;
  }
  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) });
  }
}

const metrics = {
  workflows: [],
  rateLimits: [],
  slots: { total: 2 },
  totals: { all: 1, active: 1, waitingHuman: 0 },
};

/** Minimal JSON API the queue path touches; everything else 404s so surprises surface. */
function routeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = url.replace(/^https?:\/\/[^/]+/, "");
  const body: Record<string, unknown> = {
    "/control/metrics": metrics,
    "/api/banner": { adapters: [], github: { status: "AVAILABLE", remaining: null, limit: null } },
    "/api/repos": [],
    "/api/needs-you": [],
    "/api/runs": [],
  };
  if (path in body) {
    return Promise.resolve(new Response(JSON.stringify(body[path]), { status: 200 }));
  }
  return Promise.resolve(new Response("not found", { status: 404 }));
}

/** The currently-open `/control/events` stream (the one the Queue view mounted). */
function liveStream(): FakeEventSource | undefined {
  return FakeEventSource.instances
    .filter((es) => es.url.endsWith("/control/events") && es.readyState !== 2)
    .at(-1);
}

/** Select a view tab. Radix Tabs uses automatic activation (selects on focus), so
 * focus drives the switch; click is belt-and-suspenders. */
function selectTab(container: HTMLElement, name: string): void {
  const el = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (t) => t.textContent?.trim() === name,
  );
  if (!el) throw new Error(`no "${name}" tab; have: ${container.textContent}`);
  el.focus();
  el.click();
}

let savedFetch: typeof globalThis.fetch;
let savedEventSource: typeof globalThis.EventSource;

beforeAll(async () => {
  registerDom();
  ({ App } = await import("../src/app/App.tsx"));
});
afterAll(() => unregisterDom());

afterEach(() => {
  globalThis.fetch = savedFetch;
  globalThis.EventSource = savedEventSource;
  FakeEventSource.instances = [];
});

describe("App live-queue state across view switches", () => {
  test("re-entering Queue does not show frames from the previous visit", async () => {
    savedFetch = globalThis.fetch;
    savedEventSource = globalThis.EventSource;
    globalThis.fetch = routeFetch as typeof globalThis.fetch;
    globalThis.EventSource = FakeEventSource as unknown as typeof globalThis.EventSource;

    const { container, unmount } = await renderDom(<App />);
    try {
      // Visit 1: enter Queue, push a live frame, confirm the row renders.
      await flush(() => selectTab(container, "queue"));
      await flush(() =>
        liveStream()?.emit("workflow", { id: "wf1", repo: "o/r", epic: 42, state: "running" }),
      );
      expect(container.textContent).toContain("o/r");

      // Leave Queue, then return — without emitting anything this time.
      await flush(() => selectTab(container, "activity"));
      await flush(() => selectTab(container, "queue"));

      // The stale frame must be gone (the bug: it lingered and showed "o/r").
      expect(container.textContent).toContain("nothing in flight");
      expect(container.textContent).not.toContain("o/r");
    } finally {
      await unmount();
    }
  });
});
