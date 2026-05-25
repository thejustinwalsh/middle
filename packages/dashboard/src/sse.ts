/**
 * The dashboard SSE channels — `/events/global`, `/events/repos/:repo`,
 * `/events/sessions/:session`. Each maps to a channel on the {@link
 * DashboardEventBus} (`deps.events`); a subscriber only ever receives that
 * channel's frames. Repo/session path params are URL-encoded by the client
 * (a repo is `owner/name`), so each tail segment is `decodeURIComponent`-ed.
 *
 * `handleEvents` returns a `Response` for any `/events/*` path and `undefined`
 * otherwise (so the caller can fall through). With no bus wired the channels
 * 503 — the dashboard still serves its polled JSON API.
 */

import type { DashboardDeps } from "./deps.ts";
import { GLOBAL_CHANNEL, repoChannel, sessionChannel } from "./events.ts";

/** Route an `/events/*` request to its channel. `undefined` → not an events path. */
export function handleEvents(req: Request, deps: DashboardDeps): Response | undefined {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (segments[0] !== "events") return undefined;
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });

  const bus = deps.events;
  if (!bus) return new Response("event stream unavailable (no bus wired)", { status: 503 });

  const rest = segments.slice(1).map((s) => decodeURIComponent(s));
  const [kind, ...tail] = rest;

  if (kind === "global" && tail.length === 0) {
    return bus.serve(GLOBAL_CHANNEL, req);
  }
  if (kind === "repos" && tail.length === 1 && tail[0]) {
    return bus.serve(repoChannel(tail[0]), req);
  }
  if (kind === "sessions" && tail.length === 1 && tail[0]) {
    return bus.serve(sessionChannel(tail[0]), req);
  }
  return new Response("not found", { status: 404 });
}
