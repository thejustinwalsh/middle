import { afterEach, expect, test } from "bun:test";
import { bridgeRateLimitsToBus } from "@middle/dashboard/src/bridge.ts";
import { DashboardEventBus } from "@middle/dashboard/src/events.ts";
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
    stateGateway: { readBody: async () => "" },
    runRecommender: async () => ({ status: 200, body: "ok" }),
  };
  const hosted = dashboardHostExtras(ctx as never);
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

  // The hook server's fetch fallback still answers — the SPA route is "/" (exact),
  // not "/*", so /health falls through to HookServer's #handle.
  const health = await fetch(`${base}/health`);
  expect(((await health.json()) as { ok: boolean }).ok).toBe(true);

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
