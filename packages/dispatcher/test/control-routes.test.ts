import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_HEARTBEAT_MS, EventHub } from "../src/event-hub.ts";
import { type ControlPlane, HookServer, SSE_IDLE_TIMEOUT_SECONDS } from "../src/hook-server.ts";

// The control surface (`/health`, `/control/events`, `/control/dispatch`) lives
// on the existing localhost-only dispatcher server. These tests pin the route
// contracts — health shape, dispatch body validation + engine start + returned
// id, the 409 collision guard, and that the SSE stream opens — with the engine,
// hub, and collision query injected as stubs.

let server: HookServer;
let base: string;
let startCalls: Array<{ repo: string; repoPath: string; epicRef: string; adapter: string }>;
let collisionEpics: Set<string>;
let hub: EventHub;

function makeControl(overrides: Partial<ControlPlane> = {}): ControlPlane {
  hub = new EventHub();
  return {
    hub,
    version: "1.2.3",
    adapterRejection: (name) => (name === "claude" ? null : `unknown adapter: ${name}`),
    startDispatch: async (input) => {
      // `startDispatch` is the single source of truth for the 409 guard: a
      // colliding Epic resolves `null`. The stub drives that off `collisionEpics`.
      if (collisionEpics.has(input.epicRef)) return null;
      startCalls.push(input);
      return "wf-abc";
    },
    ...overrides,
  };
}

function startWith(control: ControlPlane | undefined): void {
  server = new HookServer(undefined, undefined, undefined, control);
  server.start(0);
  base = `http://127.0.0.1:${server.port}`;
}

beforeEach(() => {
  startCalls = [];
  collisionEpics = new Set();
});

afterEach(() => {
  server.stop();
});

describe("HookServer control routes", () => {
  test("GET /health reports liveness, port, and version", async () => {
    startWith(makeControl());
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, port: server.port, version: "1.2.3" });
  });

  test("the server idle-timeout exceeds the SSE heartbeat (else /control/events streams drop)", () => {
    // Regression guard for "[Bun.serve]: request timed out after 10s": a heartbeat
    // that fires after the socket idle-timeout can't keep the stream alive.
    expect(SSE_IDLE_TIMEOUT_SECONDS * 1000).toBeGreaterThan(DEFAULT_HEARTBEAT_MS);
  });

  test("POST /control/dispatch starts the workflow and returns its id", async () => {
    startWith(makeControl());
    const res = await fetch(`${base}/control/dispatch`, {
      method: "POST",
      body: JSON.stringify({
        repo: "o/r",
        repoPath: "/abs/checkout",
        epicNumber: 7,
        adapter: "claude",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workflowId: "wf-abc" });
    expect(startCalls).toEqual([
      { repo: "o/r", repoPath: "/abs/checkout", epicRef: "7", adapter: "claude" },
    ]);
  });

  test("POST /control/dispatch rejects invalid bodies with 400 and starts nothing", async () => {
    startWith(makeControl());
    const bad = [
      { repo: "", repoPath: "/abs", epicNumber: 1, adapter: "claude" }, // empty repo
      { repo: "o/r", repoPath: "relative/path", epicNumber: 1, adapter: "claude" }, // not absolute
      { repo: "o/r", repoPath: "/abs", epicNumber: 0, adapter: "claude" }, // epic < 1
      { repo: "o/r", repoPath: "/abs", epicNumber: 1.5, adapter: "claude" }, // non-integer epic
      { repo: "o/r", repoPath: "/abs", epicNumber: 1, adapter: "ghost" }, // unknown adapter
      { repo: "o/r", repoPath: "/abs", adapter: "claude" }, // missing epic
    ];
    for (const body of bad) {
      const res = await fetch(`${base}/control/dispatch`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    // A non-JSON body is also a 400, not a crash.
    const garbled = await fetch(`${base}/control/dispatch`, { method: "POST", body: "{not json" });
    expect(garbled.status).toBe(400);
    expect(startCalls).toEqual([]);
  });

  test("POST /control/dispatch surfaces the disabled-vs-unknown distinction in the 400 body", async () => {
    // `ControlPlane.adapterRejection` is the single source of truth for the
    // wording, so the route's 400 message must reflect *why* the adapter was
    // rejected — never the misleading "unknown adapter" for a disabled-but-
    // implemented adapter. The wiring in main.ts threads `adapterRejectionReason`.
    startWith(
      makeControl({
        adapterRejection: (name) => {
          if (name === "claude") return null;
          if (name === "codex") return `adapter ${name} is disabled in config`;
          return `unknown adapter: ${name}`;
        },
      }),
    );

    const disabled = await fetch(`${base}/control/dispatch`, {
      method: "POST",
      body: JSON.stringify({ repo: "o/r", repoPath: "/abs", epicNumber: 1, adapter: "codex" }),
    });
    expect(disabled.status).toBe(400);
    expect(await disabled.json()).toEqual({ error: "adapter codex is disabled in config" });

    const unknown = await fetch(`${base}/control/dispatch`, {
      method: "POST",
      body: JSON.stringify({ repo: "o/r", repoPath: "/abs", epicNumber: 1, adapter: "ghost" }),
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: "unknown adapter: ghost" });
  });

  test("POST /control/dispatch refuses with 429 when no slot is available (manual respects limits)", async () => {
    startWith(makeControl({ slotAvailable: () => false }));
    const res = await fetch(`${base}/control/dispatch`, {
      method: "POST",
      body: JSON.stringify({
        repo: "o/r",
        repoPath: "/abs/checkout",
        epicNumber: 7,
        adapter: "claude",
      }),
    });
    expect(res.status).toBe(429);
    // The slot gate runs before the dispatch, so nothing started.
    expect(startCalls).toEqual([]);
  });

  test("POST /control/dispatch proceeds when a slot is available", async () => {
    startWith(makeControl({ slotAvailable: () => true }));
    const res = await fetch(`${base}/control/dispatch`, {
      method: "POST",
      body: JSON.stringify({
        repo: "o/r",
        repoPath: "/abs/checkout",
        epicNumber: 7,
        adapter: "claude",
      }),
    });
    expect(res.status).toBe(200);
    expect(startCalls).toHaveLength(1);
  });

  test("POST /control/dispatch survives a throwing afterDispatch (best-effort, still 200)", async () => {
    // The post-dispatch trigger is best-effort: a throw must not turn a dispatch
    // that already succeeded into a 500.
    startWith(
      makeControl({
        afterDispatch: () => {
          throw new Error("scheduler boom");
        },
      }),
    );
    const res = await fetch(`${base}/control/dispatch`, {
      method: "POST",
      body: JSON.stringify({
        repo: "o/r",
        repoPath: "/abs/checkout",
        epicNumber: 7,
        adapter: "claude",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workflowId: "wf-abc" });
    expect(startCalls).toHaveLength(1);
  });

  test("POST /control/dispatch rejects a colliding Epic with 409", async () => {
    startWith(makeControl());
    collisionEpics.add("7");
    const res = await fetch(`${base}/control/dispatch`, {
      method: "POST",
      body: JSON.stringify({
        repo: "o/r",
        repoPath: "/abs/checkout",
        epicNumber: 7,
        adapter: "claude",
      }),
    });
    expect(res.status).toBe(409);
    expect(startCalls).toEqual([]);
  });

  test("two concurrent dispatches of the same Epic: exactly one 200, one 409", async () => {
    // The atomic guard lives in the daemon's `startDispatch` (see main.test.ts
    // for the live-engine race test); here the stub emulates a single-winner
    // reserve to pin that the *route* faithfully relays it — it must not
    // reintroduce a non-atomic pre-check that lets both requests through.
    const reserved = new Set<string>();
    startWith(
      makeControl({
        startDispatch: async (input) => {
          if (reserved.has(input.epicRef)) return null; // sync check + add: no await between
          reserved.add(input.epicRef);
          await Bun.sleep(5); // hold so the two requests genuinely overlap
          startCalls.push(input);
          return `wf-${input.epicRef}`;
        },
      }),
    );
    const body = JSON.stringify({
      repo: "o/r",
      repoPath: "/abs",
      epicNumber: 9,
      adapter: "claude",
    });
    const [a, b] = await Promise.all([
      fetch(`${base}/control/dispatch`, { method: "POST", body }),
      fetch(`${base}/control/dispatch`, { method: "POST", body }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(startCalls.length).toBe(1);
  });

  test("GET /control/events opens an SSE stream with a connected frame", async () => {
    startWith(makeControl());
    const res = await fetch(`${base}/control/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("event: connected");
    await reader.cancel();
  });

  test("GET /control/events replays the injected init events", async () => {
    startWith(
      makeControl({
        initEvents: () => [
          { type: "workflow", data: { id: "wf-live", repo: "o/r", epic: 3, state: "waiting" } },
        ],
      }),
    );
    const res = await fetch(`${base}/control/events`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = decoder.decode((await reader.read()).value);
    if (!buffer.includes("wf-live")) buffer += decoder.decode((await reader.read()).value);
    expect(buffer).toContain("event: connected");
    expect(buffer).toContain("wf-live");
    await reader.cancel();
  });

  const SNAPSHOT = {
    generatedAt: 42,
    workflows: [{ repo: "o/r", kind: "implementation", state: "running", count: 2 }],
    slots: { total: 2, perAdapter: { claude: 2 } },
    rateLimits: [{ adapter: "claude", status: "AVAILABLE", resetAt: null }],
    totals: { all: 2, active: 2, waitingHuman: 0 },
  };

  test("GET / 404s in the bare server (the status page is gone; the SPA mounts via extraRoutes)", async () => {
    startWith(makeControl());
    // The old status-page branch was removed from #handle; with no extraRoutes the
    // daemon serves nothing at `/`. The dashboard SPA is mounted at `/` by the CLI
    // composition root via start(port, extraRoutes), exercised in the CLI tests.
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(404);
  });

  test("GET /metrics renders Prometheus text from the metrics seam", async () => {
    startWith(makeControl({ metrics: () => SNAPSHOT }));
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain('middle_workflows{repo="o/r",kind="implementation",state="running"} 2');
    expect(body).toContain("middle_slots_active_total 2");
  });

  test("GET /control/metrics returns the raw snapshot as JSON", async () => {
    startWith(makeControl({ metrics: () => SNAPSHOT }));
    const res = await fetch(`${base}/control/metrics`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SNAPSHOT);
  });

  test("metric routes 404 without a metrics seam", async () => {
    startWith(makeControl()); // no `metrics` override
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
    expect((await fetch(`${base}/control/metrics`)).status).toBe(404);
  });

  test("POST /control/resume fires the parked Epic's resume and returns its id", async () => {
    const resumeCalls: Array<{ repo: string; epicRef: string; answer: string }> = [];
    startWith(
      makeControl({
        resume: async (input) => {
          resumeCalls.push(input);
          return input.epicRef === "missing" ? null : "wf-resumed";
        },
      }),
    );
    const res = await fetch(`${base}/control/resume`, {
      method: "POST",
      body: JSON.stringify({ repo: "o/r", epicRef: "rollout-epic-store", answer: "go with A" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workflowId: "wf-resumed" });
    expect(resumeCalls).toEqual([
      { repo: "o/r", epicRef: "rollout-epic-store", answer: "go with A" },
    ]);
  });

  test("POST /control/resume 404s when no parked workflow owns the ref", async () => {
    startWith(makeControl({ resume: async () => null }));
    const res = await fetch(`${base}/control/resume`, {
      method: "POST",
      body: JSON.stringify({ repo: "o/r", epicRef: "missing", answer: "x" }),
    });
    expect(res.status).toBe(404);
  });

  test("POST /control/resume 400s on a missing epicRef or answer", async () => {
    startWith(makeControl({ resume: async () => "wf" }));
    for (const body of [
      { repo: "o/r", answer: "x" }, // no epicRef
      { repo: "o/r", epicRef: "s" }, // no answer
      { epicRef: "s", answer: "x" }, // no repo
    ]) {
      const res = await fetch(`${base}/control/resume`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  test("control routes 404 in gate-only mode (no control plane wired)", async () => {
    startWith(undefined);
    expect((await fetch(`${base}/control/events`)).status).toBe(404);
    const d = await fetch(`${base}/control/dispatch`, { method: "POST", body: "{}" });
    expect(d.status).toBe(404);
    const r = await fetch(`${base}/control/resume`, { method: "POST", body: "{}" });
    expect(r.status).toBe(404);
    // The metric exports need the control plane's seam → 404.
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
    // /health is unconditional liveness; version is empty without a control plane.
    const h = await fetch(`${base}/health`);
    expect(h.status).toBe(200);
    expect(await h.json()).toEqual({ ok: true, port: server.port, version: "" });
  });
});
