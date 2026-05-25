/**
 * @packageDocumentation
 * @module @middle/dashboard
 *
 * The dashboard: a React 19 SPA plus `Bun.serve` handlers (JSON API + SSE) on
 * the configured `dispatcher_port` (8822). Read-only operator surface — Needs
 * You / Repos / Inspector / Settings — over the dispatcher's SQLite state and
 * the GitHub state issue.
 *
 * Public surface:
 * - `createDashboardServer` — start the HTTP server (API + SSE + bundled SPA)
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
export { createDashboardServer, DASHBOARD_IDLE_TIMEOUT_SECONDS } from "./server.ts";
export type { DashboardServerOptions } from "./server.ts";
export { handleApi } from "./api.ts";
export { handleEvents } from "./sse.ts";
export { DashboardEventBus, GLOBAL_CHANNEL, repoChannel, sessionChannel } from "./events.ts";
export { BANNER_EVENT, bridgeRateLimitsToBus } from "./bridge.ts";
export type { DashboardDeps, TranscriptRead } from "./deps.ts";
export { createDbDeps } from "./db-deps.ts";
export type { DbDepsOptions } from "./db-deps.ts";
export { attachCommands, spawnTerminal } from "./attach.ts";
export type { TerminalSpawner } from "./attach.ts";
export type * from "./wire.ts";
