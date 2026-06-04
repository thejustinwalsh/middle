import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, api } from "../src/app/api-client.ts";
import { App, applyWorkflowFrame } from "../src/app/App.tsx";
import { GlobalBanner } from "../src/app/components/GlobalBanner.tsx";
import { NeedsYou } from "../src/app/components/NeedsYou.tsx";
import { RepoRow } from "../src/app/components/Repos.tsx";
import { createDbDeps } from "../src/db-deps.ts";
import { createDashboardServer } from "../src/server.ts";
import { makeConfig, makeDb, seedWorkflow } from "./helpers.ts";

// The React views render against the wire shapes (renderToStaticMarkup), and the
// api-client round-trips against a live server with seeded db rows — i.e. the
// app "reads from the JSON API and renders against live data".

test("App nav includes a queue entry", () => {
  const html = renderToStaticMarkup(<App />);
  expect(html).toContain('data-view="queue"');
});

test("App nav includes an activity entry", () => {
  const html = renderToStaticMarkup(<App />);
  expect(html).toContain('data-view="activity"');
});

test("App nav is the Sidebar (operator-console redesign): one `data-view` button per view", () => {
  const html = renderToStaticMarkup(<App />);
  // The Sidebar replaces the old shadcn Tabs strip. One bare <button data-view>
  // per view, plus a stable `data-slot="sidebar"` for the aside container.
  expect(html).toContain('data-slot="sidebar"');
  expect(html.match(/data-view="[a-z]+"/g)?.length).toBe(5);
});

test("api.runs reads runs from a live server", async () => {
  const { db, cleanup } = makeDb();
  try {
    db.run(
      `INSERT INTO workflows (id, kind, repo, adapter, state, created_at, updated_at)
       VALUES ('rec1', 'recommender', 'o/r', 'claude', 'completed', 1000, 4000)`,
    );
    const deps = createDbDeps({ db, config: makeConfig() });
    const server = await createDashboardServer({ deps, port: 0, serveSpa: false });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/runs`);
      expect(res.status).toBe(200);
      const runs = (await res.json()) as { workflowId: string; kind: string }[];
      expect(runs[0]).toMatchObject({ workflowId: "rec1", kind: "recommender" });
    } finally {
      server.stop(true);
    }
  } finally {
    cleanup();
  }
});

test("App defaults to the Epics view (active nav entry + empty state render)", () => {
  const html = renderToStaticMarkup(<App />);
  // The active Sidebar entry carries `data-active`; the Epics view body shows
  // its empty-state copy when no Epics are loaded.
  expect(html).toMatch(/data-view="epics"[^>]*data-active=""/);
  expect(html).toContain("No open Epics for this repo.");
});

test("api.epics reads Epic cards from a live server", async () => {
  const { db, cleanup } = makeDb();
  try {
    db.run(
      `INSERT INTO epics (repo, ref, number, title, state, labels_json, sub_total, sub_closed, last_refreshed)
       VALUES ('o/r', '247', 247, 'OAuth refresh', 'open', '[]', 4, 2, 0)`,
    );
    seedWorkflow(db, {
      id: "wf1",
      repo: "o/r",
      epicNumber: 247,
      adapter: "claude",
      state: "running",
      sessionName: "o-r-247",
      currentSubIssue: 2,
    });
    const deps = createDbDeps({ db, config: makeConfig() });
    const server = await createDashboardServer({ deps, port: 0, serveSpa: false });
    try {
      const res = await fetch(
        `http://127.0.0.1:${server.port}/api/epics/${encodeURIComponent("o/r")}`,
      );
      expect(res.status).toBe(200);
      const cards = (await res.json()) as { number: number; runner: { adapter: string } | null }[];
      expect(cards[0]).toMatchObject({ number: 247, runner: { adapter: "claude" } });
    } finally {
      server.stop(true);
    }
  } finally {
    cleanup();
  }
});

test("applyWorkflowFrame upserts non-terminal and drops terminal workflows", () => {
  let live = applyWorkflowFrame([], { id: "a", repo: "o/r", epic: 1, state: "running" });
  live = applyWorkflowFrame(live, { id: "b", repo: "o/r", epic: 2, state: "running" });
  expect(live.map((w) => w.id)).toEqual(["b", "a"]); // most-recent first
  live = applyWorkflowFrame(live, { id: "a", repo: "o/r", epic: 1, state: "completed" });
  expect(live.map((w) => w.id)).toEqual(["b"]); // terminal 'a' dropped
  live = applyWorkflowFrame(live, { id: "b", repo: "o/r", epic: 2, state: "waiting-human" });
  expect(live.map((w) => w.id)).toEqual(["b"]); // non-terminal upsert, no dup
});

describe("dashboard views (static render)", () => {
  test("GlobalBanner shows per-adapter rate limits + GitHub quota", () => {
    const html = renderToStaticMarkup(
      <GlobalBanner
        banner={{
          adapters: [
            { adapter: "claude", status: "AVAILABLE", resetAt: null },
            { adapter: "codex", status: "RATE_LIMITED", resetAt: Date.now() + 2 * 3600_000 },
          ],
          github: { status: "AVAILABLE", remaining: 4180, limit: 5000 },
        }}
      />,
    );
    expect(html).toContain("claude ✓ available");
    expect(html).toContain("codex ⏸ rate limited");
    expect(html).toContain("github ✓ available 4180/5000");
  });

  test("NeedsYou lists aggregated items and an empty state", () => {
    const filled = renderToStaticMarkup(
      <NeedsYou
        items={[
          {
            repo: "o/alpha",
            issue: 247,
            label: "ready for review",
            oneLiner: "OAuth refresh · 4/4 sub-issues",
            link: "https://x/247",
          },
        ]}
      />,
    );
    expect(filled).toContain("1 items");
    expect(filled).toContain("o/alpha #247");
    expect(filled).toContain("ready for review");

    const empty = renderToStaticMarkup(<NeedsYou items={[]} />);
    expect(empty).toContain("Nothing needs you");
  });

  test("RepoRow header (sync) shows slot pills as Badges + a Collapsible trigger", () => {
    const summary = {
      repo: "o/alpha",
      adapters: [{ adapter: "claude", used: 2, max: 2 }],
      total: { used: 2, max: 3 },
      auto: true,
    };
    const html = renderToStaticMarkup(
      <RepoRow
        summary={summary}
        expanded={false}
        loadDetail={async () => {
          throw new Error("not called");
        }}
        onToggle={() => {}}
      />,
    );
    expect(html).toContain("claude 2/2");
    expect(html).toContain("total 2/3");
    expect(html).toContain("auto ✓");
    // #220 shadcn primitives: slot pills are Badges, the header is a Collapsible
    // trigger (a Button via asChild — Radix's `data-slot="collapsible-trigger"`
    // wins over the Button's own slot on the merged element).
    expect(html).toContain('data-slot="badge"');
    expect(html).toContain('data-slot="collapsible-trigger"');
  });

  // The expanded-row content (NEXT UP / IN FLIGHT) + its #223 loading/error/retry
  // states are async (RepoExpansion self-fetches), so they're tested in DOM:
  // `repos.test.tsx` (happy path) and `error-recovery.test.tsx` (error → retry).
  // Inspector render test moved to `inspector.test.tsx` (DOM Sheet).
});

describe("api-client against a live server", () => {
  let db: Database;
  let cleanup: () => void;
  let server: Awaited<ReturnType<typeof createDashboardServer>>;
  let realFetch: typeof fetch;

  beforeEach(async () => {
    const made = makeDb();
    db = made.db;
    cleanup = made.cleanup;
    seedWorkflow(db, {
      id: "w1",
      repo: "o/alpha",
      epicNumber: 247,
      state: "running",
      sessionName: "mm-alpha-247",
      currentSubIssue: 2,
    });
    const deps = createDbDeps({
      db,
      config: makeConfig(),
      spawnTerminal: () => true,
      isSessionAlive: async () => true,
    });
    server = await createDashboardServer({ deps, port: 0, serveSpa: false });
    // The client uses same-origin relative paths; resolve them against the test server.
    const base = `http://127.0.0.1:${server.port}`;
    realFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? new URL(input, base) : input;
      return realFetch(url, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    server.stop(true);
    cleanup();
  });

  test("api.repos() + RepoRow render the live repo header", async () => {
    const repos = await api.repos();
    expect(repos.map((r) => r.repo)).toContain("o/alpha");
    // The expansion fetches via loadDetail; here we only assert the sync header
    // (the async NEXT UP / IN FLIGHT content is covered in repos.test.tsx).
    const summary = repos.find((r) => r.repo === "o/alpha")!;
    const html = renderToStaticMarkup(
      <RepoRow
        summary={summary}
        expanded={false}
        loadDetail={(r) => api.repo(r)}
        onToggle={() => {}}
      />,
    );
    expect(html).toContain("o/alpha");
  });

  test("api.attach(control) flips controlled_by; api.release reverts it", async () => {
    const before = await api.session("mm-alpha-247");
    expect(before.controlledBy).toBe("middle");

    const result = await api.attach("mm-alpha-247", "control");
    expect(result.controlledBy).toBe("human");

    const after = await api.session("mm-alpha-247");
    expect(after.controlledBy).toBe("human");

    await api.release("mm-alpha-247");
    const released = await api.session("mm-alpha-247");
    expect(released.controlledBy).toBe("middle");
  });

  test("api.runRecommender surfaces a non-2xx as an ApiError", async () => {
    // These deps wire no recommender trigger → the route 404s. The client must
    // throw (like every other method) rather than resolve the raw fetch silently.
    await expect(api.runRecommender("o/alpha")).rejects.toThrow(ApiError);
  });
});
