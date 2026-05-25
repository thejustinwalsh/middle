/**
 * The dashboard HTTP server — `Bun.serve` wiring the JSON API, the SSE channels,
 * and the bundled React SPA, all on the configured `dispatcher_port` (8822).
 *
 * Routing precedence is Bun's most-specific-first: `/api/*` and `/events/*` are
 * handled by the dashboard, everything else falls through to the SPA (the HTML
 * import, bundled by Bun's built-in bundler — no webpack/vite). Both halves go
 * through the {@link DashboardDeps} seam, so the server is exercised end-to-end
 * in tests with an in-memory fake and an ephemeral port (`port: 0`).
 *
 * The SPA is **lazily** imported (only when `serveSpa !== false`), so API/SSE
 * unit tests never trigger the bundler — they run without the React toolchain.
 */

import { DEFAULT_HEARTBEAT_MS } from "@middle/dispatcher/src/event-hub.ts";
import { handleApi } from "./api.ts";
import type { DashboardDeps } from "./deps.ts";
import { handleEvents } from "./sse.ts";

type BunServer = ReturnType<typeof Bun.serve>;

/**
 * Per-connection idle timeout (seconds) — must exceed the SSE heartbeat or Bun
 * closes a quiet `/events/*` stream between heartbeats. Derived as 2× the hub
 * heartbeat (mirrors the dispatcher's `SSE_IDLE_TIMEOUT_SECONDS`) so the two
 * never drift apart.
 */
export const DASHBOARD_IDLE_TIMEOUT_SECONDS = Math.ceil((DEFAULT_HEARTBEAT_MS / 1000) * 2);

/** Options for {@link createDashboardServer}. */
export type DashboardServerOptions = {
  /** The data + action seam every route delegates to. */
  deps: DashboardDeps;
  /** Bind port; `0` picks an ephemeral one (tests). Default 8822. */
  port?: number;
  /**
   * Serve the bundled SPA on unmatched routes. Default true. Tests that only
   * exercise the API/SSE set `false` so the HTML import (and the bundler) is
   * never loaded.
   */
  serveSpa?: boolean;
};

/** A 404 the API/SSE fall-throughs share. */
function notFound(): Response {
  return new Response("not found", { status: 404 });
}

/**
 * Start the dashboard server. Localhost-only (the operator's machine); the SPA
 * is bundled on first request. Returns the live `Bun.serve` handle — call
 * `.stop()` to shut it down. Async because the SPA bundle is lazily imported.
 */
export async function createDashboardServer(opts: DashboardServerOptions): Promise<BunServer> {
  const { deps, port = 8822, serveSpa = true } = opts;

  const routes: Record<string, (req: Request) => Response | Promise<Response>> = {
    "/api/*": async (req) => (await handleApi(req, deps)) ?? notFound(),
    "/events/*": (req) => handleEvents(req, deps) ?? notFound(),
  };

  // Mix in the bundled SPA only when asked — keeps the bundler out of API tests.
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
