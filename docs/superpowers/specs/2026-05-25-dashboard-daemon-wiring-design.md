# Design — wire the dashboard into the running daemon (#54 follow-up)

**Date:** 2026-05-25
**Status:** approved for planning

## Problem

Epic #54 built the dashboard package end-to-end — `Bun.serve` server, JSON API,
SSE channels, the React 19 SPA, settings, the `--window` launcher — but never
mounted it into a running process. `mm start` spawns the dispatcher, whose
`HookServer` binds `dispatcher_port` (8822) and serves the *old* status-page
HTML at `GET /`. So an operator who opens `http://127.0.0.1:8822/` (including via
`mm start --window`) lands on the stopgap queue-observability page, not the
dashboard. `createDashboardServer`, `createDbDeps`, and `bridgeRateLimitsToBus`
have **zero production callers**.

This was a deliberate deferral. `planning/issues/54/decisions.md`:

> "The alternative (mounting routes directly into the dispatcher's hook-server)
> is not asked for by any sub-issue and would couple the SPA to live infra;
> deferred as a one-line composition later."

This spec is that deferred composition.

## Constraints that shape the design

1. **The dashboard must run in the daemon process.** `bridgeRateLimitsToBus`
   reaches into the dispatcher's *process-global* `setRateLimitObserver`. A
   separate process cannot feed the live banner.
2. **`dispatcher` cannot import `dashboard`.** The dependency direction is
   `dashboard → dispatcher`; reversing it creates a workspace cycle and is the
   exact SPA↔daemon coupling #54 avoided. → The composition root must be the
   **CLI** (the only package that depends on both).
3. **One port.** Agents POST hooks to `dispatcher_port` (8822) and the window
   opens `8822/`. The dashboard must share 8822 with the hook/control routes.
4. **The SPA has no client-side routing.** `App.tsx` owns view state
   (`"dashboard" | "settings"` today) in React state — no History API, no deep
   links. So the daemon only needs to serve the SPA at `/`; Bun auto-registers
   the bundle's hashed JS/CSS asset routes. Every other unmatched path stays in
   the existing `fetch` fallback. **No hook route needs converting.**

## Architecture: CLI as composition root

- **`dispatcher/src/main.ts`** is refactored from a self-running script (it calls
  `main()` at module top level today) into an exported `runDaemon(opts)`. It is
  no longer the process `mm start` spawns. It gains one injection seam:

  ```ts
  export type DaemonHostContext = {
    db: Database;
    config: MiddleConfig;
    hub: EventHub;
    tmuxStatus: (session: string) => /* tmux status seam */;
    stateGateway: StateIssueGateway;       // ghStateIssueGateway
    getRateLimitState: () => RateLimitState;
    repoPaths: Map<string, string>;
  };

  export type RunDaemonOptions = {
    /** Inject extra HTTP routes (the dashboard) + a shutdown disposer. */
    hostExtras?: (ctx: DaemonHostContext) => {
      routes: Record<string, RouteHandler>;
      dispose: () => void;
    };
    // existing test seams (entrypoint overrides etc.) preserved
  };

  export async function runDaemon(opts?: RunDaemonOptions): Promise<void>;
  ```

  `DaemonHostContext` is **dashboard-agnostic** — defined in dispatcher, names no
  dashboard type. `hostExtras` is called after the db/hub/state are stood up and
  the result threaded into `HookServer.start` (see route-merge). On shutdown the
  daemon calls `dispose()` alongside its other teardown.

- **New CLI-owned entrypoint `packages/cli/src/daemon-entry.ts`** imports both
  `runDaemon` and the dashboard. It is the file `mm start` spawns. Its
  `hostExtras` implementation:

  ```ts
  hostExtras: (ctx) => {
    const bus = new DashboardEventBus();
    const deps = createDbDeps({ db: ctx.db, config: ctx.config,
                               status: ctx.tmuxStatus, stateGateway: ctx.stateGateway,
                               events: bus, /* terminal spawner default */ });
    // The banner computation already lives on the deps seam (DashboardDeps.banner);
    // reuse it rather than recomputing — GlobalBanner is a dashboard wire type.
    const disposeBanner = bridgeRateLimitsToBus(bus, () => deps.banner());
    const disposeWorkflow = bridgeWorkflowsToBus(bus, ctx); // see §Live channels
    const routes = createDashboardRoutes(deps, { serveSpa: true });
    return { routes, dispose: () => { disposeBanner(); disposeWorkflow(); } };
  }
  ```

- **`packages/cli/src/commands/start.ts`**: `resolveDispatcherEntrypoint()`
  resolves the new `daemon-entry.ts` instead of `@middle/dispatcher`'s main.
  `--window` / `[dashboard] windowed` and the `8822/` URL are unchanged.

## Route-merge (single port, `routes` + `fetch`)

`createDashboardServer` builds a Bun `routes` map: `/api/*`, `/events/*`, and
`/*` → the bundled HTML. The daemon's `HookServer` uses a single `fetch` handler.
Bun.serve accepts **both** `routes` and `fetch`; `routes` are matched
most-specific-first, and `fetch` is the fallback for anything unmatched.

Plan:

1. **Extract a composable route builder in the dashboard.** New export
   `createDashboardRoutes(deps, { serveSpa }): Record<string, RouteHandler>` —
   `/api/*` → `handleApi`, `/events/*` → `handleEvents`, and (when `serveSpa`)
   `/` → the lazily-imported HTMLBundle (exact path, **not** `/*`, so it does not
   shadow the daemon's `fetch` fallback). `createDashboardServer` is refactored to
   call this builder so its existing tests stay green (no behavior change).
2. **`HookServer.start(port, extraRoutes?)`** gains an optional routes arg and
   builds `Bun.serve({ hostname, port, idleTimeout, routes: extraRoutes ?? {},
   fetch: (req) => this.#handle(req) })`. The hook/control/gate/`/hooks/*`/
   `/health`/`/metrics` routes remain in `#handle` (the `fetch` fallback),
   unchanged except for item 3.
3. **Delete the status page.** Remove `status-page.ts`, its import, the
   `GET / | /status` branch in `hook-server.ts`, and its test. `/` is now served
   by the dashboard SPA route; `/status` 404s (its queue view moves into the SPA,
   §below).

Idle-timeout note: the dashboard's `DASHBOARD_IDLE_TIMEOUT_SECONDS` and the
dispatcher's `SSE_IDLE_TIMEOUT_SECONDS` are both 2× the hub heartbeat, so the
single server's `idleTimeout` (the hook server's existing value) already covers
both SSE surfaces.

## Port the queue view into the SPA (delete status-page.ts)

The status page is vanilla JS that subscribes to `/control/events` (SSE) and
polls `/control/metrics` (JSON) — both daemon control-plane routes that **stay**
in `fetch`. Port it as a third SPA view:

- `App.tsx` view state becomes `"dashboard" | "queue" | "settings"`; add a nav
  tab. A new `Queue.tsx` component renders in-flight / parked / rate-limited
  workflows and the aggregate gauges.
- A small control-plane client (`app/control-client.ts`) fetches
  `/control/metrics` and subscribes to `/control/events` via the existing
  `useSse` hook (same origin/port). This is distinct from the dashboard's
  `/api/*` + `/events/*` surface.
- Faithfully reproduce the status page's safety posture: `textContent` only,
  never `innerHTML` with live repo/state strings (React handles this by default).
- Delete `status-page.ts` and its test once the tab renders the same data.

## Live repo/session channels (workflow→bus bridge)

Today only `broadcastGlobal` (the banner) has a producer; `broadcastRepo` /
`broadcastSession` are never called, so the dashboard's repo/session SSE channels
emit only heartbeats and the SPA relies on polling `/api/*`. To make those views
live, add `bridgeWorkflowsToBus(bus, ctx)` in the dashboard package (mirrors
`bridgeRateLimitsToBus`): it registers on the dispatcher's existing workflow
observers (`setUpdateWorkflowObserver` for DB-only states + `engine.onAny` for
bunqueue-native states — both surfaced via `ctx`) and mirrors each transition
onto `bus.broadcastRepo(repo, …)` / `bus.broadcastSession(session, …)`.

**Scope guard:** the dispatcher already multiplexes both observer sources into
`/control/events` (see `dispatcher/CLAUDE.md`). The bridge must consume the same
union without stealing those observers from the control feed — i.e. it
*subscribes alongside*, it does not replace `setUpdateWorkflowObserver`. If the
existing observer is single-slot (process-global, one setter), this requires a
fan-out shim in the dispatcher so both the control feed and the dashboard bridge
receive transitions. Confirm during planning; if fan-out is non-trivial, ship the
mount + banner + queue-tab first and treat live repo/session push as a follow-up
(the SPA already polls, so it degrades gracefully).

## Testing

- **Dashboard:** `createDashboardRoutes` unit test (route table shape, `serveSpa`
  toggle); `createDashboardServer` existing tests stay green after refactor.
- **HookServer:** test that injected `extraRoutes` are served *and* the `fetch`
  fallback still answers `/health`, `/control/*`, `/hooks/*`; test that `/` no
  longer returns the status page.
- **CLI:** `daemon-entry`/`hostExtras` wiring test with an in-memory db + fake
  state gateway — asserts `GET /api/*`, `GET /`, and a hook POST all answer on one
  ephemeral port, and `dispose()` clears the rate-limit observer.
- **SPA:** Queue tab renders metrics + a live `/control/events` frame against a
  fake; nav switches among the three views.
- Full `bun test` + `bun run typecheck` + `bun run lint` green.

## Out of scope

- Durable config persistence (still in-memory per #54 decision).
- Auth on the dashboard surface (localhost-only, same as the hook server today).
- Two-port / proxy topologies (rejected — single shared surface chosen).
- Any change to agent hook-posting *behavior* or `dispatcher_port` *semantics*
  (the port stays the one configurable surface). The default *value* does change:
  8822 → **4120** (Initech HQ), updated in `core/src/config.ts` and the two other
  defaults — see the plan's Task 0. Verified safe: unprivileged, below the Linux
  ephemeral range, no `/etc/services` assignment, not a common dev-server port.
