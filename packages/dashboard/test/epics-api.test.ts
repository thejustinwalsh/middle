import { describe, expect, test } from "bun:test";
import { handleApi } from "../src/api.ts";
import type { DashboardDeps } from "../src/deps.ts";

function deps(over: Partial<DashboardDeps>): DashboardDeps {
  return { listEpics: async () => [] as never, ...over } as unknown as DashboardDeps;
}
const req = (path: string, method = "GET", body?: unknown) =>
  new Request(`http://x${path}`, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
      : {}),
  });

describe("/api/epics", () => {
  test("GET /api/epics/:repo returns the card list", async () => {
    const cards = [{ number: 1 }];
    const res = await handleApi(
      req("/api/epics/o%2Fr"),
      deps({ listEpics: async (r) => (r === "o/r" ? (cards as never) : []) }),
    );
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual(cards);
  });

  test("POST /api/epics/:repo/:n/dispatch forwards numeric ref as string epicRef", async () => {
    const calls: Array<{ r: string; ref: string; a: string }> = [];
    const res = await handleApi(
      req("/api/epics/o%2Fr/7/dispatch", "POST", { adapter: "claude" }),
      deps({
        dispatchEpic: async (r, ref, a) => {
          calls.push({ r, ref, a });
          return { status: 200, body: JSON.stringify({ r, ref, a }) };
        },
      }),
    );
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ r: "o/r", ref: "7", a: "claude" });
    // The seam receives the ref as a string — "7" not 7.
    expect(calls).toEqual([{ r: "o/r", ref: "7", a: "claude" }]);
  });

  test("POST /api/epics/:repo/:slug/dispatch forwards slug epicRef to the seam", async () => {
    const calls: Array<{ r: string; ref: string; a: string }> = [];
    const res = await handleApi(
      req("/api/epics/o%2Fr/rollout-epic-store/dispatch", "POST", { adapter: "claude" }),
      deps({
        dispatchEpic: async (r, ref, a) => {
          calls.push({ r, ref, a });
          return { status: 200, body: JSON.stringify({ r, ref, a }) };
        },
      }),
    );
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ r: "o/r", ref: "rollout-epic-store", a: "claude" });
    expect(calls).toEqual([{ r: "o/r", ref: "rollout-epic-store", a: "claude" }]);
  });

  test("POST /api/epics/:repo/:slug/dispatch — seam returns 404 'Epic not found' for unknown slug", async () => {
    const res = await handleApi(
      req("/api/epics/o%2Fr/no-such-slug/dispatch", "POST", { adapter: "claude" }),
      deps({
        dispatchEpic: async () => ({
          status: 404,
          body: JSON.stringify({ error: "Epic not found: no-such-slug" }),
        }),
      }),
    );
    // The route proxies the seam's status/body transparently.
    expect(res!.status).toBe(404);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toContain("Epic not found");
  });

  test("dispatch 404s when no dispatch seam is wired", async () => {
    const res = await handleApi(
      req("/api/epics/o%2Fr/7/dispatch", "POST", { adapter: "claude" }),
      deps({}),
    );
    expect(res!.status).toBe(404);
  });

  test("dispatch rejects a missing adapter with 400", async () => {
    const res = await handleApi(
      req("/api/epics/o%2Fr/7/dispatch", "POST", {}),
      deps({ dispatchEpic: async () => ({ status: 200, body: "{}" }) }),
    );
    expect(res!.status).toBe(400);
  });

  test("dispatch rejects an empty adapter string with 400", async () => {
    const res = await handleApi(
      req("/api/epics/o%2Fr/rollout-epic-store/dispatch", "POST", { adapter: "   " }),
      deps({ dispatchEpic: async () => ({ status: 200, body: "{}" }) }),
    );
    expect(res!.status).toBe(400);
  });

  test("POST /api/epics/:repo/refresh forwards", async () => {
    const res = await handleApi(
      req("/api/epics/o%2Fr/refresh", "POST"),
      deps({
        refreshEpics: async () => ({ status: 200, body: JSON.stringify({ ok: true }) }),
      }),
    );
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });
  });
});
