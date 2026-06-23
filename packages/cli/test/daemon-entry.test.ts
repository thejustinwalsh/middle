import { afterEach, expect, test } from "bun:test";
import { bridgeRateLimitsToBus } from "@middle/dashboard/src/bridge.ts";
import { DashboardEventBus } from "@middle/dashboard/src/events.ts";
import type { DaemonHostContext } from "@middle/dispatcher";
import { openAndMigrate } from "@middle/dispatcher/src/db.ts";
import { HookServer } from "@middle/dispatcher/src/hook-server.ts";
import { setRateLimited } from "@middle/dispatcher/src/rate-limits.ts";
import { makeConfig } from "../../dashboard/test/helpers.ts";
import { dashboardHostExtras } from "../src/daemon-entry.ts";

let server: HookServer | undefined;
let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  server?.stop();
  server = undefined;
  dispose = undefined;
});

test("dashboardHostExtras routes + the hook fetch fallback coexist on one port", async () => {
  const db = openAndMigrate(":memory:");
  const ctx = {
    db,
    config: makeConfig(),
    stateGateway: { readBody: async () => "", writeBody: async () => {} },
    runRecommender: async () => ({ status: 200, body: "ok" }),
    dispatch: async () => ({ status: 200, body: "ok" }),
    refreshEpics: async () => ({ status: 200, body: "ok" }),
  } satisfies DaemonHostContext;
  const hosted = dashboardHostExtras(ctx);
  dispose = hosted.dispose;
  server = new HookServer();
  server.start(0, hosted.routes);
  const base = `http://127.0.0.1:${server.port}`;

  // Dashboard API route resolves (not 404) — empty db lists zero repos at 200.
  const repos = await fetch(`${base}/api/repos`);
  expect(repos.status).toBe(200);
  expect(await repos.json()).toEqual([]);

  // The SPA is bundled and served at "/" (exact route).
  const root = await fetch(`${base}/`);
  expect(root.status).toBe(200);
  expect(root.headers.get("content-type")).toContain("text/html");

  // The non-obvious property that makes the single-port mount work: Bun serves
  // the HTMLBundle's hashed assets (at /_bun/*) WITHOUT the hook fetch fallback
  // shadowing them. Pull the first bundled asset URL out of the HTML and fetch it.
  const html = await root.text();
  const assetMatch = html.match(/\/_bun\/[^"']+/);
  if (assetMatch) {
    const asset = await fetch(`${base}${assetMatch[0]}`);
    expect(asset.status).toBe(200); // bundled asset served, not 404'd by the fallback
  } else {
    // The SPA bundles JS, so a parseable /_bun/ asset URL is expected; at minimum
    // the HTML must reference one (otherwise the mount can't be serving the bundle).
    expect(html).toContain("/_bun/");
  }

  // The hook server's fetch fallback still answers — the SPA route is "/" (exact),
  // not "/*", so /health falls through to HookServer's #handle.
  const health = await fetch(`${base}/health`);
  expect(((await health.json()) as { ok: boolean }).ok).toBe(true);

  db.close();
});

test("a dispatch POST reaches the host-context dispatch callback (numeric ref)", async () => {
  let dispatched: [string, string, string] | undefined;
  const db = openAndMigrate(":memory:");
  const ctx = {
    db,
    config: makeConfig(),
    stateGateway: { readBody: async () => "", writeBody: async () => {} },
    runRecommender: async () => ({ status: 200, body: "ok" }),
    dispatch: async (repo: string, epicRef: string, adapter: string) => {
      dispatched = [repo, epicRef, adapter];
      return { status: 200, body: JSON.stringify({ workflowId: "wf1" }) };
    },
    refreshEpics: async () => ({ status: 200, body: "ok" }),
  } satisfies DaemonHostContext;

  const hosted = dashboardHostExtras(ctx);
  dispose = hosted.dispose;
  server = new HookServer();
  server.start(0, hosted.routes);
  const base = `http://127.0.0.1:${server.port}`;

  const res = await fetch(`${base}/api/epics/${encodeURIComponent("o/r")}/7/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adapter: "claude" }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ workflowId: "wf1" });
  // The dispatch seam receives the ref as a string — "7" not 7 (route passes `:epicRef` as-is).
  expect(dispatched).toEqual(["o/r", "7", "claude"]);

  db.close();
});

test("a dispatch POST with a file-mode slug reaches the host-context dispatch callback (#240)", async () => {
  let dispatched: [string, string, string] | undefined;
  const db = openAndMigrate(":memory:");
  const ctx = {
    db,
    config: makeConfig(),
    stateGateway: { readBody: async () => "", writeBody: async () => {} },
    runRecommender: async () => ({ status: 200, body: "ok" }),
    dispatch: async (repo: string, epicRef: string, adapter: string) => {
      dispatched = [repo, epicRef, adapter];
      return { status: 200, body: JSON.stringify({ workflowId: "wf-slug" }) };
    },
    refreshEpics: async () => ({ status: 200, body: "ok" }),
  } satisfies DaemonHostContext;

  const hosted = dashboardHostExtras(ctx);
  dispose = hosted.dispose;
  server = new HookServer();
  server.start(0, hosted.routes);
  const base = `http://127.0.0.1:${server.port}`;

  const res = await fetch(
    `${base}/api/epics/${encodeURIComponent("o/r")}/${encodeURIComponent("rollout-epic-store")}/dispatch`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adapter: "claude" }),
    },
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ workflowId: "wf-slug" });
  // The slug passes through intact.
  expect(dispatched).toEqual(["o/r", "rollout-epic-store", "claude"]);

  db.close();
});

test("dispose clears the process-global rate-limit observer (no broadcast after teardown)", async () => {
  const db = openAndMigrate(":memory:");
  const bus = new DashboardEventBus();
  let broadcasts = 0;
  // Spy on the global fan-out the bridge drives on a rate-limit change.
  const original = bus.broadcastGlobal.bind(bus);
  bus.broadcastGlobal = (frame: Parameters<typeof original>[0]) => {
    broadcasts++;
    return original(frame);
  };

  // computeBanner resolves synchronously-ish so Bun.sleep(0) drains it reliably.
  const d = bridgeRateLimitsToBus(bus, async () => ({
    adapters: [],
    github: { status: "UNKNOWN" as const, remaining: null, limit: null },
  }));

  // === Positive control: bridge must be live BEFORE dispose ===
  // Trigger a flip and drain the microtask queue so the async computeBanner().then
  // chain has a chance to run. This proves the test harness can observe a broadcast
  // at all — without this, a vacuous test would pass even if dispose did nothing.
  setRateLimited(db, { adapter: "claude", resetAt: null, source: "test" });
  await Bun.sleep(0);
  expect(broadcasts).toBeGreaterThan(0); // bridge IS live — at least one broadcast fired

  // === Invariant: no broadcast after dispose ===
  const baseline = broadcasts;
  d(); // dispose — clears the process-global observer
  d(); // disposing twice must not throw

  setRateLimited(db, { adapter: "codex", resetAt: null, source: "test" });
  await Bun.sleep(0); // drain microtasks — any queued .then() would fire here
  expect(broadcasts).toBe(baseline); // no new broadcast after dispose

  db.close();
});
