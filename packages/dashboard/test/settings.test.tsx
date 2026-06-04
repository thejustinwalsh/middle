import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { renderToStaticMarkup } from "react-dom/server";
import { Settings } from "../src/app/components/Settings.tsx";
import { createDbDeps } from "../src/db-deps.ts";
import { createDashboardServer } from "../src/server.ts";
import type { SettingsWire } from "../src/wire.ts";
import { makeConfig, makeDb, seedWorkflow } from "./helpers.ts";

// The settings round-trip through the API (#58): read, edit global config,
// pause/resume a repo, clear a rate limit — each change is reflected back by a
// fresh GET. Plus a static render of the Settings view.

let db: Database;
let cleanup: () => void;
let server: Awaited<ReturnType<typeof createDashboardServer>>;
let base: string;

beforeEach(async () => {
  const made = makeDb();
  db = made.db;
  cleanup = made.cleanup;
  seedWorkflow(db, { id: "w1", repo: "o/alpha", state: "running", sessionName: "s1" });
  const deps = createDbDeps({ db, config: makeConfig() });
  server = await createDashboardServer({ deps, port: 0, serveSpa: false });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  server.stop(true);
  cleanup();
});

const enc = encodeURIComponent;
const getSettings = async (): Promise<SettingsWire> =>
  (await (await fetch(`${base}/api/settings`)).json()) as SettingsWire;

describe("settings round-trip through the API", () => {
  test("GET /api/settings returns global + per-repo config", async () => {
    const s = await getSettings();
    expect(s.global).toEqual({ maxConcurrent: 4, defaultAdapter: "claude" });
    expect(s.repos.find((r) => r.repo === "o/alpha")).toMatchObject({
      repo: "o/alpha",
      auto: true,
    });
  });

  test("POST /api/settings/global persists and is reflected back", async () => {
    const res = await fetch(`${base}/api/settings/global`, {
      method: "POST",
      body: JSON.stringify({ maxConcurrent: 8, defaultAdapter: "codex" }),
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as SettingsWire;
    expect(updated.global).toEqual({ maxConcurrent: 8, defaultAdapter: "codex" });
    // A fresh read sees the same — it round-tripped, not just echoed.
    expect((await getSettings()).global).toEqual({ maxConcurrent: 8, defaultAdapter: "codex" });
  });

  test("POST /api/settings/global rejects a non-positive maxConcurrent", async () => {
    const res = await fetch(`${base}/api/settings/global`, {
      method: "POST",
      body: JSON.stringify({ maxConcurrent: 0 }),
    });
    expect(res.status).toBe(400);
    expect((await getSettings()).global.maxConcurrent).toBe(4); // unchanged
  });

  test("pause/resume toggles a repo's auto-dispatch", async () => {
    expect((await getSettings()).repos.find((r) => r.repo === "o/alpha")?.auto).toBe(true);

    await fetch(`${base}/api/repos/${enc("o/alpha")}/pause`, { method: "POST" });
    expect((await getSettings()).repos.find((r) => r.repo === "o/alpha")?.auto).toBe(false);

    await fetch(`${base}/api/repos/${enc("o/alpha")}/resume`, { method: "POST" });
    expect((await getSettings()).repos.find((r) => r.repo === "o/alpha")?.auto).toBe(true);
  });

  test("the rate-limit override button's endpoint sets the adapter AVAILABLE", async () => {
    const res = await fetch(`${base}/api/rate-limits/claude/clear`, { method: "POST" });
    expect(res.status).toBe(200);
    const banner = (await (await fetch(`${base}/api/banner`)).json()) as {
      adapters: { adapter: string; status: string }[];
    };
    expect(banner.adapters.find((a) => a.adapter === "claude")?.status).toBe("AVAILABLE");
  });
});

describe("Settings view (static render)", () => {
  test("renders global fields, rate-limit override, and per-repo auto toggle", () => {
    const html = renderToStaticMarkup(
      <Settings
        settings={{
          global: { maxConcurrent: 4, defaultAdapter: "claude" },
          repos: [{ repo: "o/alpha", auto: false, pausedUntil: Number.MAX_SAFE_INTEGER }],
        }}
        banner={{
          adapters: [{ adapter: "claude", status: "RATE_LIMITED", resetAt: null }],
          github: { status: "UNKNOWN", remaining: null, limit: null },
        }}
        onSaveGlobal={() => {}}
        onPauseRepo={() => {}}
        onResumeRepo={() => {}}
        onClearRateLimit={() => {}}
      />,
    );
    expect(html).toContain("max concurrent");
    expect(html).toContain("default adapter");
    expect(html).toContain("clear override");
    expect(html).toContain("o/alpha");
    expect(html).toContain("resume"); // auto is off → resume button
    // #220 shadcn primitives: Inputs, Buttons, and a Badge for the rate-limit status.
    expect(html.match(/data-slot="input"/g)?.length).toBe(2);
    expect(html).toContain('data-slot="button"');
    expect(html).toContain('data-slot="badge"');
  });
});
