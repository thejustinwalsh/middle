import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createDashboardRoutes } from "../src/server.ts";
import { createDbDeps } from "../src/db-deps.ts";
import { makeConfig, makeDb } from "./helpers.ts";

// Tests for createDashboardRoutes — the API+SSE route table without the SPA.

let db: Database;
let cleanup: () => void;

beforeEach(() => {
  const made = makeDb();
  db = made.db;
  cleanup = made.cleanup;
});

afterEach(() => {
  cleanup();
});

test("createDashboardRoutes maps /api/* and /events/* to the deps seam", async () => {
  const deps = createDbDeps({ db, config: makeConfig() });
  const routes = createDashboardRoutes(deps);
  expect(Object.keys(routes).sort()).toEqual(["/api/*", "/events/*"]);
  const apiRoute = routes["/api/*"];
  if (!apiRoute) throw new Error("expected an /api/* route");
  const res = await apiRoute(new Request("http://x/api/repos"));
  expect(res).toBeInstanceOf(Response);
  expect(res.status).toBe(200); // empty db returns 200 with []
});
