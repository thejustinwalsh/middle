import { expect, test } from "bun:test";
import { fetchControlMetrics, type ControlMetrics } from "../src/app/control-client.ts";

test("fetchControlMetrics parses the /control/metrics snapshot", async () => {
  const snapshot: ControlMetrics = {
    workflows: [{ repo: "o/r", kind: "implementation", state: "running", count: 1 }],
    rateLimits: [],
    slots: { total: 1 },
    totals: { all: 1, active: 1, waitingHuman: 0 },
  };
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(snapshot))) as unknown as typeof fetch;
  try {
    expect(await fetchControlMetrics()).toEqual(snapshot);
  } finally {
    globalThis.fetch = orig;
  }
});

test("fetchControlMetrics throws on a non-OK response", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response("boom", { status: 503 })) as unknown as typeof fetch;
  try {
    await expect(fetchControlMetrics()).rejects.toThrow("/control/metrics 503");
  } finally {
    globalThis.fetch = orig;
  }
});
