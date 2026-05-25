/**
 * The dashboard SSE channels — `/events/global`, `/events/repos/:repo`,
 * `/events/sessions/:session`. Full fan-out (subscribe to the dispatcher's
 * `EventHub`, filter per channel) lands in Phase #57; this module owns the
 * routing and the no-hub fallback now so `server.ts` can wire `/events/*`.
 *
 * `handleEvents` returns a `Response` for any `/events/*` path and `undefined`
 * otherwise (so the caller can fall through). When no hub is wired the channels
 * 503 — the dashboard still serves its polled JSON API.
 */

import type { DashboardDeps } from "./deps.ts";

/** Route an `/events/*` request. `undefined` → not an events path. */
export function handleEvents(req: Request, deps: DashboardDeps): Response | undefined {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (segments[0] !== "events") return undefined;
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });

  if (!deps.hub) {
    return new Response("event stream unavailable (no hub wired)", { status: 503 });
  }
  // Full per-channel fan-out arrives in Phase #57.
  return new Response("event stream unavailable", { status: 503 });
}
