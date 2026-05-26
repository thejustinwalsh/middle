import { describe, expect, test } from "bun:test";
import { handleApi } from "../src/api.ts";
import type { DashboardDeps } from "../src/deps.ts";

function deps(over: Partial<DashboardDeps>): DashboardDeps {
  return { listRuns: async () => [] as never, ...over } as unknown as DashboardDeps;
}
const req = (path: string, method = "GET") => new Request(`http://x${path}`, { method });

describe("/api/runs", () => {
  test("GET /api/runs returns the run list", async () => {
    const runs = [{ workflowId: "rec1", kind: "recommender" }];
    const res = await handleApi(req("/api/runs"), deps({ listRuns: async () => runs as never }));
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual(runs);
  });

  test("a non-GET method on /api/runs is a 404 miss", async () => {
    const res = await handleApi(req("/api/runs", "POST"), deps({}));
    expect(res!.status).toBe(404);
  });
});
