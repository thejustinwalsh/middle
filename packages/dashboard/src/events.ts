/**
 * The dashboard's channel-keyed SSE bus. The spec splits live updates into three
 * channels — global, per-repo, per-session — but the dispatcher's `EventHub`
 * fans every event out to every subscriber with no server-side filtering. This
 * bus layers channels on top: one `EventHub` per channel key, created lazily,
 * so a subscriber to `/events/repos/o/alpha` only ever sees that repo's frames.
 *
 * Producers (the daemon, the dispatcher's rate-limit observer, the hook store)
 * call `broadcastGlobal` / `broadcastRepo` / `broadcastSession`; the SSE routes
 * call `serve`. A hub's heartbeat self-stops with its last subscriber, and the
 * bus sweeps drained (zero-subscriber) hubs out of the map on the next `serve`,
 * so the map stays bounded by channels with live subscribers — it doesn't grow
 * with every repo/session ever touched.
 */

import { type Event, EventHub, type EventHubOptions } from "@middle/dispatcher/src/event-hub.ts";

/** The fixed global channel key. */
export const GLOBAL_CHANNEL = "global";

/** The channel key for a repo's events. */
export function repoChannel(repo: string): string {
  return `repo:${repo}`;
}

/** The channel key for a session's events. */
export function sessionChannel(session: string): string {
  return `session:${session}`;
}

/** A channel-scoped fan-out: one {@link EventHub} per channel key. */
export class DashboardEventBus {
  readonly #hubs = new Map<string, EventHub>();
  readonly #hubOptions: EventHubOptions;

  constructor(hubOptions: EventHubOptions = {}) {
    this.#hubOptions = hubOptions;
  }

  /** Get the hub for a channel, creating it on first use. */
  #hub(channel: string): EventHub {
    let hub = this.#hubs.get(channel);
    if (!hub) {
      hub = new EventHub(this.#hubOptions);
      this.#hubs.set(channel, hub);
    }
    return hub;
  }

  /** Serve a new SSE subscriber on a channel (a `connected` frame, then live frames). */
  serve(channel: string, req: Request, initEvents: Event[] = []): Response {
    // Sweep hubs that have drained to zero subscribers before adding a new one.
    // A hub with no subscribers carries no live state (its heartbeat already
    // self-stopped), so dropping it is safe — a later subscriber or broadcast
    // re-creates it lazily. This bounds the map to channels with live (or
    // just-served) subscribers rather than every channel ever touched.
    this.#pruneEmpty(channel);
    return this.#hub(channel).serve(req, initEvents);
  }

  /** Drop every hub with no current subscribers, except `keep` (about to be served). */
  #pruneEmpty(keep: string): void {
    for (const [key, hub] of this.#hubs) {
      if (key !== keep && hub.subscriberCount() === 0) this.#hubs.delete(key);
    }
  }

  /** Live channel (hub) count — for observability and tests. */
  channelCount(): number {
    return this.#hubs.size;
  }

  /** Fan an event out to a channel's subscribers. */
  broadcast(channel: string, event: Event): void {
    // No subscribers yet → no hub yet → nothing to deliver (and no hub to create).
    this.#hubs.get(channel)?.broadcast(event);
  }

  /** Broadcast on the global channel (banner / rate-limit / GitHub quota updates). */
  broadcastGlobal(event: Event): void {
    this.broadcast(GLOBAL_CHANNEL, event);
  }

  /** Broadcast on a repo's channel (slot changes, workflow transitions, state-issue updates). */
  broadcastRepo(repo: string, event: Event): void {
    this.broadcast(repoChannel(repo), event);
  }

  /** Broadcast on a session's channel (hook events, runner-panel updates). */
  broadcastSession(session: string, event: Event): void {
    this.broadcast(sessionChannel(session), event);
  }

  /** Total live subscribers across all channels — for observability and tests. */
  subscriberCount(): number {
    let total = 0;
    for (const hub of this.#hubs.values()) total += hub.subscriberCount();
    return total;
  }
}
