/**
 * @packageDocumentation
 * @module @middle/dashboard
 *
 * The dashboard: a React 19 SPA plus `Bun.serve` handlers (JSON API + SSE) on
 * the configured `dispatcher_port` (4120). Read-only operator surface — Needs
 * You / Repos / Inspector / Settings — over the dispatcher's SQLite state and
 * the GitHub state issue.
 *
 * Public surface:
 * - `createDashboardServer` — start the HTTP server (API + SSE + bundled SPA)
 * - `createDashboardRoutes` — the /api/* + /events/* route table, for merging into another Bun.serve
 * - `DashboardDeps` — the data + action seam every route delegates to
 * - `createDbDeps` — the production seam, backed by the SQLite db + state issue
 * - `handleApi` — the JSON API router (`/api/*`), usable without a live server
 * - `attachCommands` / `spawnTerminal` — the tmux attach affordances
 * - the `wire.ts` types — the JSON contract shared with the SPA
 *
 * Where things live:
 * - `server.ts` — the `Bun.serve` entry (the package `main`); lazy-bundles the SPA
 * - `api.ts` — the `/api/*` route table; `sse.ts` — the `/events/*` channels
 * - `events.ts` — the channel-keyed SSE bus; `bridge.ts` — dispatcher→bus wiring
 * - `deps.ts` — the `DashboardDeps` seam; `db-deps.ts` — its db/state-issue impl
 * - `attach.ts` — `tmux attach` command builders + terminal spawn
 * - `window.ts` — the optional `webview-bun` launcher (spawned by `mm start --window`)
 * - `index.html` + `app/` — the React 19 SPA, bundled by Bun's built-in bundler
 *
 * Gotchas:
 * - Repo (`owner/name`) and session path params are URL-encoded by callers so a
 *   slash doesn't split the segment; the API decodes each.
 * - The SPA is imported lazily in `server.ts` (`serveSpa: false` skips it) so
 *   API/SSE tests never load the bundler.
 *
 * claude-md: false
 */
/** Start the dashboard `Bun.serve` (API + SSE + bundled SPA); `DASHBOARD_IDLE_TIMEOUT_SECONDS` is its idle-socket timeout. */
export { createDashboardServer, DASHBOARD_IDLE_TIMEOUT_SECONDS } from "./server.ts";
/** Options accepted by {@link createDashboardServer} (deps, port, whether to serve the SPA). */
export type { DashboardServerOptions } from "./server.ts";
/** The dashboard's `/api/*` + `/events/*` route table, for merging into another `Bun.serve`. */
export { createDashboardRoutes } from "./server.ts";
/** The function-route table shape returned by {@link createDashboardRoutes}. */
export type { DashboardRoutes } from "./server.ts";
/** The `/api/*` JSON router — returns a `Response`, or `undefined` for a non-API path. Usable without a live server. */
export { handleApi } from "./api.ts";
/** The `/events/*` SSE router — returns a `Response`, or `undefined` for a non-events path. */
export { handleEvents } from "./sse.ts";
/** The channel-keyed SSE bus plus the channel-key builders (`global`, `repo:<repo>`, `session:<session>`). */
export { DashboardEventBus, GLOBAL_CHANNEL, repoChannel, sessionChannel } from "./events.ts";
/** The rate-limit→banner event name and the wiring that rebroadcasts dispatcher rate-limit changes onto the bus. */
export { BANNER_EVENT, bridgeRateLimitsToBus } from "./bridge.ts";
/** The data + action seam every route delegates to (`DashboardDeps`) and the transcript-read shape it returns. */
export type { DashboardDeps, TranscriptRead } from "./deps.ts";
/** Build the production {@link DashboardDeps} backed by the SQLite db + GitHub state issue. */
export { createDbDeps } from "./db-deps.ts";
/** Options for {@link createDbDeps} (db handle, config, optional terminal/liveness/state-gateway seams). */
export type { DbDepsOptions } from "./db-deps.ts";
/** Build the `tmux attach` watch/control commands for a session, and the default terminal spawner. */
export { attachCommands, spawnTerminal } from "./attach.ts";
/** The terminal-spawn seam: given a shell command, open it (returns whether a terminal was launched). */
export type { TerminalSpawner } from "./attach.ts";
/** The JSON wire contract shared with the SPA (repo/runner/banner/settings shapes). */
export type * from "./wire.ts";
