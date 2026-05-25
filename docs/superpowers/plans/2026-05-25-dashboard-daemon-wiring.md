# Dashboard Daemon Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mount the already-built dashboard (SPA + JSON API + SSE) into the running daemon on `dispatcher_port` (8822), folding the old status page in as a Queue tab, so `mm start` serves the dashboard instead of the stopgap status HTML.

**Architecture:** The CLI is the composition root (only package depending on both `dispatcher` and `dashboard`). `dispatcher/src/main.ts` becomes an exported `runDaemon(opts)` with a dashboard-agnostic `hostExtras(ctx)` seam; a new `packages/cli/src/daemon-entry.ts` implements that seam by building the dashboard deps/bus/routes and injecting them. The daemon's single `Bun.serve` merges the dashboard's `routes` (`/api/*`, `/events/*`, `/` SPA) with the hook server's existing `fetch` fallback — no hook route is converted, because the SPA has no client-side routing.

**Tech Stack:** Bun ≥ 1.3.12, TypeScript, React 19, `Bun.serve` (`routes` + `fetch`), `bun test`.

**Spec:** `docs/superpowers/specs/2026-05-25-dashboard-daemon-wiring-design.md`

---

## File Structure

- `packages/dashboard/src/server.ts` — **modify**: extract `createDashboardRoutes(deps)`; `createDashboardServer` consumes it.
- `packages/dashboard/src/index.ts` — **modify**: export `createDashboardRoutes` + `DashboardRoutes`.
- `packages/dispatcher/src/hook-server.ts` — **modify**: `start(port, extraRoutes?)`; drop the status-page `/`+`/status` branch.
- `packages/dispatcher/src/status-page.ts` — **delete** (after Task 8).
- `packages/dispatcher/test/status-page.test.ts` — **delete** if present.
- `packages/dispatcher/src/main.ts` — **modify**: `main()` → exported `runDaemon(opts)`; add `DaemonHostContext`/`RunDaemonOptions`; thread `hostExtras`; `import.meta.main` guard.
- `packages/cli/src/daemon-entry.ts` — **create**: composition root spawned by `mm start`.
- `packages/cli/src/commands/start.ts` — **modify**: `resolveDispatcherEntrypoint` → the local `daemon-entry.ts`.
- `packages/dashboard/src/app/control-client.ts` — **create**: typed `/control/metrics` fetch + control event type.
- `packages/dashboard/src/app/components/Queue.tsx` — **create**: the ported queue view.
- `packages/dashboard/src/app/App.tsx` — **modify**: third view `"queue"` + nav tab.
- `packages/core/src/config.ts` — **modify**: default `dispatcher_port` 8822 → 4120 (Task 0).
- `packages/cli/src/commands/start.ts` — **modify**: `DEFAULT_DISPATCHER_PORT` fallback → 4120 (Task 0).
- `packages/dashboard/src/server.ts` — **modify**: `createDashboardServer` `port = 4120` default (Task 0).

---

## Task 0: Change the default dispatcher port to 4120

The canonical default lives in one place (`core/src/config.ts`); everything else
reads `config.global.dispatcherPort`. Only three real defaults plus doc-comment
literals need updating. 4120 is safe: unprivileged (registered range), below the
Linux ephemeral range (32768–60999, so never collides with OS client ports), no
`/etc/services` assignment, not a common dev-server port. Independent of the
wiring work — do it first.

**Files:**
- Modify: `packages/core/src/config.ts:131`
- Modify: `packages/cli/src/commands/start.ts:27`
- Modify: `packages/dashboard/src/server.ts:55` (+ its header comment, line 3)
- Modify: doc-comment literals: `packages/dashboard/src/index.ts:6`, `packages/core/src/adapter.ts:87`
- Test: `packages/core/test/config.test.ts` (the default-port assertion)

- [ ] **Step 1: Update the failing test first**

In `packages/core/test/config.test.ts`, find the assertion on the default
`dispatcherPort` (grep `8822` / `dispatcherPort`) and change the expected value to
`4120`:

```ts
expect(config.global.dispatcherPort).toBe(4120);
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test packages/core/test/config.test.ts -t "dispatcher"`
Expected: FAIL — still resolves 8822.

- [ ] **Step 3: Change the canonical default**

`packages/core/src/config.ts:131`: `dispatcher_port: 8822,` → `dispatcher_port: 4120,`

- [ ] **Step 4: Change the two other defaults**

`packages/cli/src/commands/start.ts:27`: `const DEFAULT_DISPATCHER_PORT = 8822;` → `4120;`
`packages/dashboard/src/server.ts:55`: `const { deps, port = 8822, serveSpa = true } = opts;` → `port = 4120`

- [ ] **Step 5: Update doc-comment literals (grep to be exhaustive)**

Run: `grep -rn "8822" packages --include=*.ts` and replace each remaining `8822`
mention in comments/TSDoc with `4120` (`dashboard/src/server.ts:3`,
`dashboard/src/index.ts:6`, `core/src/adapter.ts:87`). These are comments, not
logic, but leaving a stale `8822` is misleading.

- [ ] **Step 6: Verify**

Run: `bun test packages/core/test/config.test.ts && grep -rn "8822" packages --include=*.ts`
Expected: config test PASS; grep returns no hits.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/config.ts packages/cli/src/commands/start.ts packages/dashboard/src/server.ts packages/dashboard/src/index.ts packages/core/src/adapter.ts packages/core/test/config.test.ts
git commit -m "feat(core): default dispatcher port 8822 -> 4120"
```

---

## Task 1: Extract `createDashboardRoutes` from the dashboard server

**Files:**
- Modify: `packages/dashboard/src/server.ts`
- Modify: `packages/dashboard/src/index.ts`
- Test: `packages/dashboard/test/server.test.ts` (add cases)

- [ ] **Step 1: Write the failing test**

Add to `packages/dashboard/test/server.test.ts` (reuse the in-memory `deps` fake from `helpers.ts`):

```ts
import { createDashboardRoutes } from "../src/server.ts";
import { makeFakeDeps } from "./helpers.ts"; // existing fake builder

test("createDashboardRoutes maps /api/* and /events/* to the deps seam", async () => {
  const routes = createDashboardRoutes(makeFakeDeps());
  expect(Object.keys(routes).sort()).toEqual(["/api/*", "/events/*"]);
  const res = await routes["/api/*"](new Request("http://x/api/repos"));
  expect(res).toBeInstanceOf(Response);
  expect(res.status).not.toBe(404); // /api/repos is a real route
});
```

(If `helpers.ts` exposes the fake under another name, use that — grep `test/helpers.ts` for the exported builder.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/dashboard/test/server.test.ts -t "createDashboardRoutes"`
Expected: FAIL — `createDashboardRoutes` is not exported.

- [ ] **Step 3: Implement the extraction**

In `packages/dashboard/src/server.ts`, add above `createDashboardServer`:

```ts
/** The function-routes (`/api/*`, `/events/*`) the dashboard serves, sans SPA. */
export type DashboardRoutes = Record<string, (req: Request) => Response | Promise<Response>>;

/**
 * Build the dashboard's API + SSE route table (no SPA — the bundled HTML is mixed
 * in by the caller, which owns the `serveSpa` decision and the route key the
 * bundle binds to). Lets the daemon merge these into its own `Bun.serve` without
 * pulling the bundler.
 */
export function createDashboardRoutes(deps: DashboardDeps): DashboardRoutes {
  return {
    "/api/*": async (req) => (await handleApi(req, deps)) ?? notFound(),
    "/events/*": (req) => handleEvents(req, deps) ?? notFound(),
  };
}
```

Then rewrite `createDashboardServer`'s body to consume it:

```ts
export async function createDashboardServer(opts: DashboardServerOptions): Promise<BunServer> {
  const { deps, port = 4120, serveSpa = true } = opts; // 4120: the default Task 0 set
  const routes = createDashboardRoutes(deps);

  let htmlRoutes: Record<string, unknown> = {};
  if (serveSpa) {
    const index = (await import("./index.html")).default;
    htmlRoutes = { "/*": index };
  }

  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: DASHBOARD_IDLE_TIMEOUT_SECONDS,
    routes: { ...routes, ...(htmlRoutes as Record<string, never>) },
  });
}
```

- [ ] **Step 4: Export from the module front door**

In `packages/dashboard/src/index.ts`, add beside the existing `createDashboardServer` export:

```ts
/** The dashboard's `/api/*` + `/events/*` route table, for merging into another `Bun.serve`. */
export { createDashboardRoutes } from "./server.ts";
export type { DashboardRoutes } from "./server.ts";
```

- [ ] **Step 5: Run the full dashboard suite (no regression)**

Run: `bun test packages/dashboard`
Expected: PASS — existing `createDashboardServer` tests stay green; new test passes.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src/server.ts packages/dashboard/src/index.ts packages/dashboard/test/server.test.ts
git commit -m "refactor(dashboard): extract createDashboardRoutes for daemon merge"
```

---

## Task 2: `HookServer.start` accepts extra routes; drop the status page

**Files:**
- Modify: `packages/dispatcher/src/hook-server.ts`
- Test: `packages/dispatcher/test/hook-server.test.ts` (add cases)

- [ ] **Step 1: Write the failing tests**

Add to `packages/dispatcher/test/hook-server.test.ts`:

```ts
describe("HookServer — merged routes", () => {
  test("extraRoutes are served, and the fetch fallback still answers /health", async () => {
    const s = new HookServer();
    s.start(0, { "/api/ping": () => new Response("pong") });
    try {
      const ping = await fetch(`http://127.0.0.1:${s.port}/api/ping`);
      expect(await ping.text()).toBe("pong");
      const health = await fetch(`http://127.0.0.1:${s.port}/health`);
      expect(((await health.json()) as { ok: boolean }).ok).toBe(true);
    } finally {
      s.stop();
    }
  });

  test("GET / no longer returns the status page (404 with no SPA route)", async () => {
    const s = new HookServer();
    s.start(0);
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/`);
      expect(res.status).toBe(404);
    } finally {
      s.stop();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/dispatcher/test/hook-server.test.ts -t "merged routes"`
Expected: FAIL — `start` takes one arg; `/` still returns 200 status-page HTML.

- [ ] **Step 3: Add the `extraRoutes` param**

In `packages/dispatcher/src/hook-server.ts`, change `start`:

```ts
/**
 * Bind the server. `extraRoutes` are merged into `Bun.serve`'s `routes` (matched
 * most-specific-first); everything unmatched falls through to `#handle` (the
 * `fetch` path). The daemon passes the dashboard's `/api/*` + `/events/*` + `/`
 * SPA here so one server serves both surfaces on `dispatcher_port`.
 */
start(port: number, extraRoutes: Record<string, unknown> = {}): void {
  this.#server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: SSE_IDLE_TIMEOUT_SECONDS,
    routes: extraRoutes as Record<string, never>,
    fetch: (req) => this.#handle(req),
  });
}
```

- [ ] **Step 4: Remove the status-page branch from `#handle`**

Delete these lines from `#handle` (currently `hook-server.ts:196-203`):

```ts
    // Observability surfaces (read-only). The status page is a static asset and
    // serves unconditionally; the metric exports need the db-backed `metrics`
    // seam and 404 in gate-only mode.
    if (req.method === "GET" && (pathname === "/" || pathname === "/status")) {
      return new Response(STATUS_PAGE_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      });
    }
```

Also remove the now-unused import `import { STATUS_PAGE_HTML } from "./status-page.ts";`. (`/metrics` and `/control/*` branches stay.)

- [ ] **Step 5: Run to verify pass**

Run: `bun test packages/dispatcher/test/hook-server.test.ts`
Expected: PASS. (A pre-existing test asserting `GET /` returns the status page, if any, must be updated/removed here — grep the file for `STATUS_PAGE` / `"/status"` and delete those assertions.)

- [ ] **Step 6: Commit**

```bash
git add packages/dispatcher/src/hook-server.ts packages/dispatcher/test/hook-server.test.ts
git commit -m "feat(dispatcher): HookServer.start accepts extra routes; drop status-page branch"
```

---

## Task 3: `main.ts` → exported `runDaemon(opts)` with `hostExtras` seam

**Files:**
- Modify: `packages/dispatcher/src/main.ts`
- Modify: `packages/dispatcher/src/index.ts` (export the new surface)

This task has no new unit test of its own (it is exercised end-to-end by Task 4's integration test); verify by typecheck + the existing dispatcher suite staying green.

- [ ] **Step 1: Add the public types near the top of `main.ts`**

After the imports, add:

```ts
/**
 * The dashboard-agnostic context the daemon hands to {@link RunDaemonOptions.hostExtras}.
 * Names no dashboard type — the CLI composition root maps these primitives onto
 * the dashboard's seams.
 */
export type DaemonHostContext = {
  db: ReturnType<typeof openAndMigrate>;
  config: ReturnType<typeof loadConfig>;
  stateGateway: typeof ghStateIssueGateway;
  runRecommender: (repo: string) => Promise<{ status: number; body: string }>;
};

/** Options for {@link runDaemon}. `hostExtras` injects the dashboard (or any extra routes). */
export type RunDaemonOptions = {
  /**
   * Mount extra HTTP routes on the daemon's single server and register a disposer
   * run on shutdown. Called once after the db/state are up, before the server binds.
   */
  hostExtras?: (ctx: DaemonHostContext) => {
    routes: Record<string, unknown>;
    dispose: () => void;
  };
};
```

- [ ] **Step 2: Rename `main` and thread `hostExtras`**

Change the signature `async function main(): Promise<void> {` to:

```ts
export async function runDaemon(opts: RunDaemonOptions = {}): Promise<void> {
```

Add a holder for the disposer near the other shutdown-scoped locals (just before `const shutdown = ...` is fine to declare it earlier — put it right after `db` is opened):

```ts
let hostDispose: (() => void) | null = null;
```

In the `bindServer` callback, replace the `hookServer.start(...)` line. Current:

```ts
      hookServer = new HookServer(new DbHookStore(db), prReadyGate, recommenderTrigger, control);
      hookServer.start(config.global.dispatcherPort);
```

New:

```ts
      hookServer = new HookServer(new DbHookStore(db), prReadyGate, recommenderTrigger, control);
      let extraRoutes: Record<string, unknown> = {};
      if (opts.hostExtras) {
        const hosted = opts.hostExtras({
          db,
          config,
          stateGateway: ghStateIssueGateway,
          runRecommender: async (repo: string) => {
            const path = repoPaths.get(repo);
            if (path === undefined) return { status: 404, body: `no checkout for ${repo}` };
            return recommenderTrigger({ repoPath: path });
          },
        });
        extraRoutes = hosted.routes;
        hostDispose = hosted.dispose;
      }
      hookServer.start(config.global.dispatcherPort, extraRoutes);
```

(`recommenderTrigger`'s exact call shape: confirm against `main.ts:299` — it is `async ({ repoPath }) => …`. Adapt the wrapper if the param name differs.)

- [ ] **Step 3: Dispose on shutdown**

In the `shutdown` function, add a guarded teardown alongside the others (after `setRateLimitObserver(null);`):

```ts
    try {
      hostDispose?.();
    } catch (error) {
      console.error(`shutdown: host dispose failed — ${(error as Error).message}`);
    }
```

- [ ] **Step 4: Replace the bottom self-run with an `import.meta.main` guard**

Change the file's last block from:

```ts
main().catch((error: unknown) => {
  console.error(`middle dispatcher failed: ${(error as Error).message}`);
  process.exit(1);
});
```

to:

```ts
// Standalone run (`bun main.ts`) starts the daemon WITHOUT the dashboard. The CLI
// (`mm start`) spawns daemon-entry.ts instead, which calls runDaemon with hostExtras.
if (import.meta.main) {
  runDaemon().catch((error: unknown) => {
    console.error(`middle dispatcher failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Export the surface from the dispatcher front door**

In `packages/dispatcher/src/index.ts`, add:

```ts
/** Start the long-running daemon; `hostExtras` injects the dashboard. The CLI is the only caller that injects. */
export { runDaemon } from "./main.ts";
export type { DaemonHostContext, RunDaemonOptions } from "./main.ts";
```

Update the `index.ts` module-index frontmatter `Public surface:` list to mention `runDaemon` (the module-index check gates on the frontmatter, not on this entry, but keep it accurate).

- [ ] **Step 6: Verify typecheck + dispatcher suite**

Run: `bun run typecheck && bun test packages/dispatcher`
Expected: PASS. (Standalone `bun packages/dispatcher/src/main.ts` still self-runs via the guard.)

- [ ] **Step 7: Commit**

```bash
git add packages/dispatcher/src/main.ts packages/dispatcher/src/index.ts
git commit -m "feat(dispatcher): export runDaemon with a hostExtras injection seam"
```

---

## Task 4: CLI `daemon-entry.ts` composition root + repoint `mm start`

**Files:**
- Create: `packages/cli/src/daemon-entry.ts`
- Modify: `packages/cli/src/commands/start.ts`
- Test: `packages/cli/test/daemon-entry.test.ts`

- [ ] **Step 1: Write the composition root**

Create `packages/cli/src/daemon-entry.ts`:

```ts
/**
 * The process `mm start` spawns. The composition root that wires the dashboard
 * into the daemon: it depends on both `@middle/dispatcher` and `@middle/dashboard`
 * (the dispatcher cannot import the dashboard without a cycle), runs them in ONE
 * process so the rate-limit bridge reaches the daemon's process-global observers,
 * and merges the dashboard's routes onto the daemon's single server.
 */
import { runDaemon } from "@middle/dispatcher";
import {
  bridgeRateLimitsToBus,
  createDashboardRoutes,
  createDbDeps,
  DashboardEventBus,
} from "@middle/dashboard";

runDaemon({
  hostExtras: (ctx) => {
    const bus = new DashboardEventBus();
    const deps = createDbDeps({
      db: ctx.db,
      config: ctx.config,
      stateGateway: ctx.stateGateway,
      events: bus,
      runRecommender: ctx.runRecommender,
    });
    // Live banner: a usage-limit detection broadcasts a fresh banner on the global
    // channel within ~2s. The bridge reaches the dispatcher's process-global
    // rate-limit observer (it imports it directly), so this MUST run in-process.
    const disposeBanner = bridgeRateLimitsToBus(bus, () => deps.banner());

    // The daemon binds the SPA at "/" (exact), NOT "/*": a wildcard would shadow
    // the hook server's fetch fallback (/health, /control/*, /hooks/*). Bun still
    // auto-serves the bundle's hashed JS/CSS assets at their own routes.
    const index = require("@middle/dashboard/src/index.html").default;
    const routes = { ...createDashboardRoutes(deps), "/": index };

    return { routes, dispose: disposeBanner };
  },
}).catch((error: unknown) => {
  console.error(`middle daemon failed: ${(error as Error).message}`);
  process.exit(1);
});
```

> NOTE on the HTML import: Bun bundles `index.html` when imported. Static `import x from "...index.html"` is cleanest, but it must stay in this CLI-owned file (never in dispatcher). If a top-level `import` of `.html` trips the typechecker, use the dynamic form `const index = (await import("@middle/dashboard/src/index.html")).default;` inside an `async` `hostExtras` — and widen `RunDaemonOptions.hostExtras` to allow a `Promise` return. Confirm which the bundler accepts during Step 4; prefer the static import and a sync `hostExtras`.

- [ ] **Step 2: Repoint `mm start` at the new entrypoint**

In `packages/cli/src/commands/start.ts`, change `resolveDispatcherEntrypoint`:

```ts
import { join } from "node:path";
// ...
function resolveDispatcherEntrypoint(): string {
  // mm start now spawns the CLI-owned daemon entry (dispatcher + dashboard in one
  // process), not @middle/dispatcher's bare main.
  return join(import.meta.dir, "..", "daemon-entry.ts");
}
```

(The `opts.entrypoint` override is preserved for tests.)

- [ ] **Step 3: Write the integration test**

Create `packages/cli/test/daemon-entry.test.ts`. It boots `runDaemon` with the same `hostExtras` wiring against an in-memory db + fake state gateway on an ephemeral port, and asserts all three surfaces answer:

```ts
import { afterEach, expect, test } from "bun:test";
import { runDaemon } from "@middle/dispatcher";
import { createDashboardRoutes, createDbDeps, DashboardEventBus } from "@middle/dashboard";
import { openAndMigrate } from "@middle/dispatcher/src/db.ts";

// Helper: start runDaemon on an ephemeral port via the MIDDLE_CONFIG seam, then
// resolve the bound base URL. (Mirror the existing dispatcher integration test's
// bootstrap — grep packages/dispatcher/test for a runDaemon/main boot helper and
// reuse it; if none exists, set dispatcherPort: 0 via a temp config.toml and read
// the port from GET /health.)

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { await stop?.(); stop = null; });

test("daemon serves dashboard /api, SPA /, and a hook POST on one port", async () => {
  // ... boot runDaemon with hostExtras building createDashboardRoutes(deps) + "/" index ...
  // const base = `http://127.0.0.1:${port}`;
  // expect((await fetch(`${base}/api/repos`)).status).not.toBe(404);
  // expect((await fetch(`${base}/`)).headers.get("content-type")).toContain("text/html");
  // const hook = await fetch(`${base}/hooks/session.started`, { method: "POST", headers: { "X-Middle-Session": "middle-1" }, body: "{}" });
  // expect(hook.status).toBe(200);
});

test("dispose clears the rate-limit observer", () => {
  const bus = new DashboardEventBus();
  // const dispose = bridgeRateLimitsToBus(bus, async () => fakeBanner);
  // dispose();
  // setRateLimited(...) must NOT broadcast after dispose — assert no frame on a global subscriber.
});
```

> Fill the bootstrap from the existing dispatcher daemon test harness. If `runDaemon` proves awkward to stop in-test (it `await`s a never-resolving promise + installs SIGTERM), assert the **merge** at the unit level instead: construct a `HookServer`, call `start(0, { ...createDashboardRoutes(deps), "/api/health-probe": () => new Response("x") })`, and verify `/api/*`, the SPA-less `/` 404, and `/hooks/*` all behave. The non-negotiable assertion: dashboard routes + hook fetch fallback coexist on one port.

- [ ] **Step 4: Run typecheck + the new test + a smoke boot**

Run: `bun run typecheck && bun test packages/cli/test/daemon-entry.test.ts`
Expected: PASS.

Smoke (manual, optional): `bun packages/cli/src/daemon-entry.ts` with a test `MIDDLE_CONFIG`, then `curl -s localhost:8822/ | head` shows the SPA HTML (`<div id="root">`), and `curl -s localhost:8822/health` shows `{"ok":true}`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/daemon-entry.ts packages/cli/src/commands/start.ts packages/cli/test/daemon-entry.test.ts
git commit -m "feat(cli): daemon-entry composition root; mm start serves the dashboard"
```

---

## Task 5: SPA control-plane client for the queue view

**Files:**
- Create: `packages/dashboard/src/app/control-client.ts`
- Test: `packages/dashboard/test/control-client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/dashboard/test/control-client.test.ts`:

```ts
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
  globalThis.fetch = async () => new Response(JSON.stringify(snapshot)) as never;
  try {
    expect(await fetchControlMetrics()).toEqual(snapshot);
  } finally {
    globalThis.fetch = orig;
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/dashboard/test/control-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the client**

Create `packages/dashboard/src/app/control-client.ts`. The shapes mirror the dispatcher's `MetricsSnapshot` (`metrics.ts`) and the `/control/events` frame (`{ type: "workflow", data: { id, repo, epic, state } }`):

```ts
/**
 * Client for the dispatcher's control plane (`/control/metrics`, `/control/events`)
 * — the engine-observability surface the Queue tab renders. Distinct from the
 * dashboard's own `/api/*` + `/events/*`; same origin/port (the daemon serves both).
 */

/** A live workflow-transition frame from `/control/events` (named event `workflow`). */
export type ControlWorkflowFrame = { id: string; repo: string; epic: number | null; state: string };

/** One `(repo, kind, state)` bucket from `/control/metrics`. */
export type WorkflowStateCount = { repo: string; kind: string; state: string; count: number };

/** The `/control/metrics` JSON snapshot (subset the Queue tab reads). */
export type ControlMetrics = {
  workflows: WorkflowStateCount[];
  rateLimits: { adapter: string; status: string }[];
  slots: { total: number };
  totals: { all: number; active: number; waitingHuman: number };
};

/** Fetch the aggregate queue gauges. Throws on a non-OK response. */
export async function fetchControlMetrics(): Promise<ControlMetrics> {
  const res = await fetch("/control/metrics");
  if (!res.ok) throw new Error(`/control/metrics ${res.status}`);
  return (await res.json()) as ControlMetrics;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/dashboard/test/control-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/app/control-client.ts packages/dashboard/test/control-client.test.ts
git commit -m "feat(dashboard): control-plane client for the queue view"
```

---

## Task 6: Queue tab component

**Files:**
- Create: `packages/dashboard/src/app/components/Queue.tsx`
- Test: `packages/dashboard/test/queue.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `packages/dashboard/test/queue.test.tsx` (follow `test/app.test.tsx`'s render harness — it uses `react-dom/server` or a test renderer; match it):

```tsx
import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { Queue } from "../src/app/components/Queue.tsx";

test("Queue renders totals and in-flight rows from a metrics snapshot", () => {
  const html = renderToString(
    <Queue
      metrics={{
        workflows: [{ repo: "o/r", kind: "implementation", state: "running", count: 2 }],
        rateLimits: [],
        slots: { total: 2 },
        totals: { all: 2, active: 2, waitingHuman: 0 },
      }}
      live={[{ id: "w1", repo: "o/r", epic: 7, state: "running" }]}
    />,
  );
  expect(html).toContain("o/r");
  expect(html).toContain("running");
});

test("Queue shows an empty state with no data", () => {
  const html = renderToString(<Queue metrics={null} live={[]} />);
  expect(html).toContain("no data yet");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/dashboard/test/queue.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement `Queue.tsx`**

Create `packages/dashboard/src/app/components/Queue.tsx`. React escapes text by default, preserving the status page's `textContent`-only safety posture:

```tsx
/**
 * The queue-observability tab — the ported successor to the dispatcher's old
 * status page. Renders the aggregate gauges and the in-flight/parked workflows
 * from `/control/metrics`, refreshed live by `/control/events` frames (passed in
 * by `App`). Read-only; React's default escaping replaces the old page's manual
 * `textContent` discipline.
 */
import type { ControlMetrics, ControlWorkflowFrame } from "../control-client.ts";

type QueueProps = {
  /** Latest `/control/metrics` snapshot, or null before the first fetch. */
  metrics: ControlMetrics | null;
  /** Live workflow frames (most-recent state per id), parked-for-human first. */
  live: ControlWorkflowFrame[];
};

/** Parked-waiting-on-human rows sort to the top — they're what needs attention. */
function sortLive(rows: ControlWorkflowFrame[]): ControlWorkflowFrame[] {
  return [...rows].sort((a, b) => {
    if (a.state === "waiting-human" && b.state !== "waiting-human") return -1;
    if (b.state === "waiting-human" && a.state !== "waiting-human") return 1;
    return 0;
  });
}

export function Queue({ metrics, live }: QueueProps): JSX.Element {
  if (!metrics) return <main className="queue"><p className="empty">no data yet</p></main>;
  const rows = sortLive(live);
  return (
    <main className="queue">
      <section className="tiles">
        <div className="tile"><div className="n">{metrics.totals.active}</div><div className="l">Active</div></div>
        <div className="tile"><div className="n">{metrics.totals.waitingHuman}</div><div className="l">Waiting for you</div></div>
        <div className="tile"><div className="n">{metrics.totals.all}</div><div className="l">Total workflows</div></div>
      </section>
      <h2>In flight &amp; parked</h2>
      <table className="active">
        <thead><tr><th>repo</th><th>epic</th><th>state</th></tr></thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={3} className="empty">nothing in flight</td></tr>
          ) : (
            rows.map((w) => (
              <tr key={w.id}>
                <td>{w.repo || "—"}</td>
                <td>{w.epic === null ? "—" : `#${w.epic}`}</td>
                <td className={`state s-${w.state}`}>{w.state}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <h2>Rate limits</h2>
      <div className="chips">
        {metrics.rateLimits.length === 0 ? (
          <span className="empty">no rate-limit data</span>
        ) : (
          metrics.rateLimits.map((r) => <span key={r.adapter} className={`c-${r.status.toLowerCase()}`}>{r.adapter}: {r.status}</span>)
        )}
      </div>
    </main>
  );
}
```

(Reuse the existing `styles.css` state classes — `s-running`, `s-rate-limited`, etc. carried over from the status page; add any missing ones to `styles.css`.)

- [ ] **Step 4: Run to verify pass**

Run: `bun test packages/dashboard/test/queue.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/app/components/Queue.tsx packages/dashboard/test/queue.test.tsx
git commit -m "feat(dashboard): Queue tab — ported status-page view"
```

---

## Task 7: Wire the Queue tab into `App` (nav + live subscription)

**Files:**
- Modify: `packages/dashboard/src/app/App.tsx`
- Test: `packages/dashboard/test/app.test.tsx` (add a nav case)

- [ ] **Step 1: Write the failing test**

Add to `packages/dashboard/test/app.test.tsx` (match the file's existing render/click harness):

```tsx
test("nav exposes a queue tab that renders the Queue view", async () => {
  // render <App/>, click the "queue" nav button, assert the queue heading appears.
  // (Mirror the existing settings-tab test in this file for the click + assert pattern.)
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/dashboard/test/app.test.tsx -t "queue tab"`
Expected: FAIL — no queue button/view.

- [ ] **Step 3: Wire it into `App.tsx`**

Three edits:

1. Widen the view state (`App.tsx:42`):
```ts
const [view, setView] = useState<"dashboard" | "queue" | "settings">("dashboard");
const [queueMetrics, setQueueMetrics] = useState<ControlMetrics | null>(null);
const [queueLive, setQueueLive] = useState<ControlWorkflowFrame[]>([]);
```

2. Fetch metrics on entering the queue view, and subscribe to `/control/events` while it's active (mirrors the settings-view effect at `App.tsx:183`):
```ts
useEffect(() => {
  if (view !== "queue") return;
  void fetchControlMetrics().then(setQueueMetrics).catch(() => setQueueMetrics(null));
}, [view]);

useEventStream(view === "queue" ? "/control/events" : null, {
  workflow: (data) => {
    const f = data as ControlWorkflowFrame;
    setQueueLive((prev) => [f, ...prev.filter((p) => p.id !== f.id)]);
  },
});
```
(Imports: `import { fetchControlMetrics, type ControlMetrics, type ControlWorkflowFrame } from "./control-client.ts";` `import { useEventStream } from "./useSse.ts";` `import { Queue } from "./components/Queue.tsx";`)

3. Add the nav button (beside the existing dashboard/settings buttons in the `<nav className="view-nav">` block) and the render branch:
```tsx
<button type="button" className={view === "queue" ? "active" : ""} onClick={() => setView("queue")}>queue</button>
```
```tsx
{view === "queue" ? <Queue metrics={queueMetrics} live={queueLive} /> : null}
```
(Insert the `queue` branch into the existing `view === "settings" ? … : …` conditional chain.)

- [ ] **Step 4: Run the dashboard suite**

Run: `bun test packages/dashboard`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/app/App.tsx packages/dashboard/test/app.test.tsx
git commit -m "feat(dashboard): wire the Queue tab into the SPA nav"
```

---

## Task 8: Delete the old status page

**Files:**
- Delete: `packages/dispatcher/src/status-page.ts`
- Delete: `packages/dispatcher/test/status-page.test.ts` (if present)

- [ ] **Step 1: Confirm nothing imports it**

Run: `grep -rn "status-page\|STATUS_PAGE_HTML" packages --include=*.ts`
Expected: no hits (Task 2 removed the import).

- [ ] **Step 2: Delete**

```bash
git rm packages/dispatcher/src/status-page.ts
git rm packages/dispatcher/test/status-page.test.ts 2>/dev/null || true
```

- [ ] **Step 3: Verify the whole repo is green**

Run: `bun run typecheck && bun test && bun run lint`
Expected: PASS across all packages.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(dispatcher): remove the status page (folded into the dashboard Queue tab)"
```

---

## Task 9 (follow-up, optional): live repo/session SSE channels

> **Deferrable.** Tasks 1–8 deliver a working, reachable dashboard; the repo/session
> views already poll `/api/*`, so they refresh — just not push-live. Do this task
> only if push-live repo/session updates are wanted now. Per the spec's scope
> guard, `setUpdateWorkflowObserver` is single-slot and owned by `main.ts`, so
> feeding the dashboard bus needs a fan-out, not a second `set*Observer` call.

**Files:**
- Modify: `packages/dispatcher/src/workflow-record.ts` (fan-out registry)
- Create: `packages/dashboard/src/bridge.ts` addition `bridgeWorkflowsToBus`
- Modify: `packages/cli/src/daemon-entry.ts` (call it; add to `dispose`)

- [ ] **Step 1:** Add a multi-subscriber fan-out in `workflow-record.ts` — keep the existing single `setUpdateWorkflowObserver` (main.ts's broadcast) and add `addWorkflowObserver(cb): () => void` whose callbacks also fire inside `updateWorkflow`. Test: two registered observers both receive a patch; the disposer removes one without affecting the other.
- [ ] **Step 2:** Add `bridgeWorkflowsToBus(bus, addObserver)` to `dashboard/src/bridge.ts` mirroring `bridgeRateLimitsToBus`: on each transition, `bus.broadcastRepo(repo, { type: "workflow", data: { id, state } })` and the session channel when a session is known. Export it from `index.ts`. Test with a fake bus + a manual observer call.
- [ ] **Step 3:** In `daemon-entry.ts`, expose `addWorkflowObserver` through `DaemonHostContext` (extend the struct in Task 3's seam), call `bridgeWorkflowsToBus`, and fold its disposer into the returned `dispose`.
- [ ] **Step 4:** `bun run typecheck && bun test && bun run lint`; commit `feat(dashboard): push live repo/session SSE via workflow bridge`.

---

## Self-Review notes (resolved)

- **Spec coverage:** composition root (T3/T4), single-port route-merge (T1/T2/T4), status-page→Queue port (T5/T6/T7), status-page deletion (T8), live channels (T9, scoped follow-up per spec). All spec sections map to a task.
- **Type consistency:** `createDashboardRoutes` (T1) ↔ consumed in T4; `runDaemon`/`DaemonHostContext` (T3) ↔ consumed in T4; `ControlMetrics`/`ControlWorkflowFrame` (T5) ↔ consumed in T6/T7. `useEventStream` is the real hook name (not `useSse`), imported from `./useSse.ts`.
- **Known confirm-at-execution points (flagged inline, not placeholders):** (a) whether the `.html` import in `daemon-entry.ts` is static or dynamic — affects whether `hostExtras` returns sync or a Promise; (b) the `test/helpers.ts` fake-deps builder name; (c) the dispatcher daemon test bootstrap to reuse for T4's integration test.
