import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { clearRateLimitObservers, setRateLimited } from "@middle/dispatcher/src/rate-limits.ts";
import {
  clearWorkflowObservers,
  updateWorkflow,
} from "@middle/dispatcher/src/workflow-record.ts";
import { bridgeRateLimitsToBus, bridgeWorkflowsToBus } from "../src/bridge.ts";
import { createDbDeps } from "../src/db-deps.ts";
import { DashboardEventBus } from "../src/events.ts";
import { createDashboardServer } from "../src/server.ts";
import { makeConfig, makeDb, seedWorkflow } from "./helpers.ts";

// The SSE channels end-to-end: a real `Bun.serve`, a real `DashboardEventBus`,
// a live HTTP SSE connection. Each test opens the stream, waits for the
// `connected` frame, broadcasts, and asserts the frame arrives on the right
// channel (and only there).

let db: Database;
let cleanup: () => void;
let server: Awaited<ReturnType<typeof createDashboardServer>>;
let bus: DashboardEventBus;
let base: string;

beforeEach(async () => {
  const made = makeDb();
  db = made.db;
  cleanup = made.cleanup;
  bus = new DashboardEventBus({ heartbeatMs: 1000 });
  const deps = createDbDeps({ db, config: makeConfig(), events: bus });
  server = await createDashboardServer({ deps, port: 0, serveSpa: false });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  clearRateLimitObservers(); // never leak the process-global observers across tests
  clearWorkflowObservers();
  server.stop(true);
  cleanup();
});

/**
 * Open an SSE connection, run `afterConnected` once the `connected` frame lands,
 * then resolve with the first frame whose `event:` type matches `wantType`.
 * Rejects after `timeoutMs` so a missing frame fails fast.
 */
async function awaitEvent(
  url: string,
  wantType: string,
  afterConnected: () => void | Promise<void>,
  timeoutMs = 2000,
): Promise<unknown> {
  const ctrl = new AbortController();
  // A blocking `reader.read()` (or a stuck SSE handshake) can't observe a
  // deadline checked inline, so arm a timer that aborts the connection — the
  // abort is what unblocks the pending fetch/read, and the catch below
  // translates it back into the timeout error. The fetch lives *inside* the try
  // so a timeout during connect is translated too, not leaked as a raw AbortError.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const decoder = new TextDecoder();
  let buf = "";
  let connectedFired = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "text/event-stream" },
    });
    if (!res.ok || !res.body) throw new Error(`SSE open failed (${res.status}) for ${url}`);
    reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream closed before "${wantType}"`);
      buf += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line; parse complete ones out of `buf`.
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const typeLine = frame.split("\n").find((l) => l.startsWith("event: "));
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        const type = typeLine?.slice("event: ".length);
        if (type === "connected" && !connectedFired) {
          connectedFired = true;
          await afterConnected();
        } else if (type === wantType) {
          return dataLine ? JSON.parse(dataLine.slice("data: ".length)) : null;
        }
      }
    }
  } catch (e) {
    if (timedOut) throw new Error(`timed out waiting for "${wantType}" on ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
    reader?.cancel().catch(() => {});
  }
}

describe("dashboard SSE channels", () => {
  test("GET /events/global delivers a broadcast on the global channel", async () => {
    const data = await awaitEvent(`${base}/events/global`, "banner", () => {
      bus.broadcastGlobal({ type: "banner", data: { hello: "world" } });
    });
    expect(data).toEqual({ hello: "world" });
  });

  test("GET /events/repos/:repo delivers only that repo's events", async () => {
    const repo = "o/alpha";
    const data = await awaitEvent(
      `${base}/events/repos/${encodeURIComponent(repo)}`,
      "workflow",
      () => {
        // A different repo's broadcast must NOT arrive here.
        bus.broadcastRepo("o/other", { type: "workflow", data: { repo: "o/other" } });
        bus.broadcastRepo(repo, { type: "workflow", data: { repo, state: "running" } });
      },
    );
    expect(data).toEqual({ repo, state: "running" });
  });

  test("GET /events/sessions/:session delivers session timeline frames", async () => {
    const data = await awaitEvent(`${base}/events/sessions/sess-7`, "session-event", () => {
      bus.broadcastSession("sess-7", {
        type: "session-event",
        data: { ts: 1, type: "agent.stopped", payload: null },
      });
    });
    expect(data).toMatchObject({ type: "agent.stopped" });
  });

  test("a rate-limit detection pushes a fresh banner on the global channel (the ≤2s path)", async () => {
    const deps = createDbDeps({ db, config: makeConfig(), events: bus });
    const dispose = bridgeRateLimitsToBus(bus, () => deps.banner());
    try {
      const banner = (await awaitEvent(`${base}/events/global`, "banner", () => {
        // Simulate a usage-limit detection — the observer recomputes + broadcasts.
        setRateLimited(db, {
          adapter: "claude",
          resetAt: Date.now() + 3600_000,
          source: "stop-hook",
        });
      })) as { adapters: { adapter: string; status: string }[] };
      expect(banner.adapters.find((a) => a.adapter === "claude")?.status).toBe("RATE_LIMITED");
    } finally {
      dispose();
    }
  });

  test("a workflow transition pushes a `workflow` nudge on that repo's channel", async () => {
    const repo = "o/alpha";
    seedWorkflow(db, { id: "wf-1", repo, epicNumber: 7, state: "launching" });
    const dispose = bridgeWorkflowsToBus(bus, db);
    try {
      const data = (await awaitEvent(
        `${base}/events/repos/${encodeURIComponent(repo)}`,
        "workflow",
        () => {
          updateWorkflow(db, "wf-1", { state: "running" });
        },
      )) as { id: string; repo: string; epic: number | null; state: string };
      expect(data).toEqual({ id: "wf-1", repo, epic: 7, state: "running" });
    } finally {
      dispose();
    }
  });

  test("disposing the workflow bridge stops the repo-channel nudges", () => {
    const repo = "o/alpha";
    seedWorkflow(db, { id: "wf-1", repo, state: "launching" });
    let nudges = 0;
    const orig = bus.broadcastRepo.bind(bus);
    bus.broadcastRepo = (r, e) => {
      if (e.type === "workflow") nudges += 1;
      orig(r, e);
    };
    const dispose = bridgeWorkflowsToBus(bus, db);
    updateWorkflow(db, "wf-1", { state: "running" });
    expect(nudges).toBe(1);
    dispose();
    updateWorkflow(db, "wf-1", { state: "waiting-human" });
    expect(nudges).toBe(1); // no further nudge after dispose
  });

  test("a malformed percent-encoded channel segment is a 400, not a crash", async () => {
    const res = await fetch(`${base}/events/repos/%ZZ`, {
      headers: { accept: "text/event-stream" },
    });
    expect(res.status).toBe(400);
  });

  test("the /events/* routes 503 when no bus is wired", async () => {
    const deps = createDbDeps({ db, config: makeConfig() }); // no events bus
    const noBus = await createDashboardServer({ deps, port: 0, serveSpa: false });
    try {
      const res = await fetch(`http://127.0.0.1:${noBus.port}/events/global`);
      expect(res.status).toBe(503);
    } finally {
      noBus.stop(true);
    }
  });
});

describe("DashboardEventBus channel pruning", () => {
  test("drained (zero-subscriber) channels are swept out on the next serve", () => {
    const localBus = new DashboardEventBus();
    const c1 = new AbortController();
    localBus.serve("repo:o/alpha", new Request("http://x/", { signal: c1.signal }));
    expect(localBus.channelCount()).toBe(1);
    expect(localBus.subscriberCount()).toBe(1);

    // The subscriber disconnects → the hub drains to zero subscribers.
    c1.abort();
    expect(localBus.subscriberCount()).toBe(0);

    // Serving a different channel sweeps the now-empty hub out of the map.
    const c2 = new AbortController();
    localBus.serve("repo:o/beta", new Request("http://x/", { signal: c2.signal }));
    expect(localBus.channelCount()).toBe(1); // only o/beta remains, o/alpha pruned
    c2.abort();
  });
});
