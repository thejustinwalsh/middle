import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createDbDeps } from "../src/db-deps.ts";
import { createDashboardServer } from "../src/server.ts";
import { makeConfig, makeDb } from "./helpers.ts";

// Verifies the SPA actually bundles through Bun's built-in bundler via the HTML
// import (#55's "bundled with Bun's built-in bundler using HTML imports"), and
// that the API coexists with the SPA fallback on the same server. This is the
// only test that flips `serveSpa: true`, so it's the one that exercises the
// bundler; the rest stay bundler-free for speed.

let db: Database;
let cleanup: () => void;
let server: Awaited<ReturnType<typeof createDashboardServer>>;
let base: string;

beforeEach(async () => {
  const made = makeDb();
  db = made.db;
  cleanup = made.cleanup;
  const deps = createDbDeps({ db, config: makeConfig() });
  server = await createDashboardServer({ deps, port: 0, serveSpa: true });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  server.stop(true);
  cleanup();
});

describe("dashboard SPA + server", () => {
  test("GET / serves the bundled HTML shell", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain('id="root"');
    // Bun rewrites the `./app/main.tsx` script src to a bundled, hashed `.js`.
    const match = body.match(/src="([^"]+\.js)"/);
    expect(match).not.toBeNull();
  });

  test("the bundled entry script transpiles the TSX app", async () => {
    const body = await (await fetch(`${base}/`)).text();
    const match = body.match(/src="([^"]+\.js)"/);
    expect(match).not.toBeNull();
    const src = match?.[1];
    expect(typeof src).toBe("string");
    const js = await fetch(base + src);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    const code = await js.text();
    // A real React bundle, not the raw TSX (which would still contain `</main>`).
    expect(code.length).toBeGreaterThan(1000);
    expect(code).not.toContain("</main>");
  });

  test("the JSON API coexists with the SPA fallback on the same server", async () => {
    const api = await fetch(`${base}/api/repos`);
    expect(api.status).toBe(200);
    expect(api.headers.get("content-type")).toContain("application/json");
    expect(await api.json()).toEqual([]);

    // An unknown non-API path falls through to the SPA (client-side routing).
    const spa = await fetch(`${base}/repos/o/alpha`);
    expect(spa.status).toBe(200);
    expect(spa.headers.get("content-type")).toContain("text/html");
  });
});
