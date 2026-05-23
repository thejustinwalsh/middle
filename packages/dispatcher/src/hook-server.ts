import { timingSafeEqual } from "node:crypto";
import type { HookPayload, NormalizedEvent } from "@middle/core";
import { isNormalizedEvent } from "@middle/core";
import type { HookStore } from "./hook-store.ts";

type BunServer = ReturnType<typeof Bun.serve>;

/**
 * Constant-time string compare. Length is leaked (unavoidable, and tokens are
 * fixed-length UUIDs), but the per-byte comparison is not short-circuited, so a
 * caller can't time their way to the correct token.
 */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The readiness/turn-boundary channel the `implementation` workflow waits on.
 * In production this is satisfied by the agent's hooks POSTing to `HookServer`;
 * tests substitute a stub.
 */
export type SessionGate = {
  awaitSessionStart(sessionName: string, timeoutMs: number): Promise<HookPayload>;
  awaitStop(sessionName: string, timeoutMs: number): Promise<HookPayload>;
};

type Waiter = {
  resolve: (payload: HookPayload) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * The hook receiver. It validates `:event` against the normalized taxonomy,
 * authenticates each request against the per-session token, hands the body to
 * the persistence store, and delivers the two load-bearing events —
 * `session.started` (carries `session_id` + `transcript_path`, signals
 * readiness) and `agent.stopped` (the turn boundary) — to whoever is awaiting
 * them on the `SessionGate`.
 *
 * The store is *optional*: with no store the server runs in gate-only mode
 * (unauthenticated, no persistence), which is how the `SessionGate` mechanics
 * are unit-tested in isolation. The live dispatcher always supplies a
 * `DbHookStore`, so production traffic is always authenticated and persisted.
 *
 * Payloads that arrive before anyone is waiting are stashed and handed to the
 * next awaiter, so a fast hook cannot race ahead of the workflow step.
 */
export class HookServer implements SessionGate {
  #server: BunServer | undefined;
  readonly #waiters = new Map<string, Waiter>();
  readonly #stashed = new Map<string, HookPayload>();
  readonly #store: HookStore | undefined;

  constructor(store?: HookStore) {
    this.#store = store;
  }

  start(port: number): void {
    // Bind localhost only. The Phase 1 receiver has no HMAC auth and uses
    // predictable session names, so a 0.0.0.0 bind (Bun's default) would let
    // any host on the network POST a fake agent.stopped / session.started and
    // hijack a running workflow. The dispatcherUrl is 127.0.0.1 everywhere.
    this.#server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: (req) => this.#handle(req),
    });
  }

  stop(): void {
    this.#server?.stop(true);
    this.#server = undefined;
    for (const waiter of this.#waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("hook server stopped"));
    }
    this.#waiters.clear();
    this.#stashed.clear();
  }

  /** The bound port — meaningful after `start`; resolves an ephemeral `start(0)`. */
  get port(): number {
    return this.#server?.port ?? 0;
  }

  async #handle(req: Request): Promise<Response> {
    const match = /^\/hooks\/(.+)$/.exec(new URL(req.url).pathname);
    if (!match || req.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    const eventName = match[1]!;
    // Validate the event name before touching the body or the store: an unknown
    // event is a malformed request, not a droppable no-op.
    if (!isNormalizedEvent(eventName)) {
      console.error(`[hook-server] rejected unknown event "${eventName}"`);
      return new Response("unknown event", { status: 400 });
    }
    const event: NormalizedEvent = eventName;

    let payload: HookPayload = {};
    try {
      payload = (await req.json()) as HookPayload;
    } catch {
      // tolerate an empty/garbled body — the hook still signals the event fired,
      // and never crash the receiver on a bad payload
    }
    const sessionName =
      req.headers.get("X-Middle-Session") ??
      (typeof payload.sessionName === "string" ? payload.sessionName : "");
    if (sessionName === "") {
      // No session identity → nothing can ever await this. Reject rather than
      // stash an unreachable entry under an empty key.
      console.error(`[hook-server] rejected ${event} with no session identity`);
      return new Response("missing session", { status: 400 });
    }

    // Authenticate against the per-session token when a store is wired. The
    // store resolves the expected token from the workflow row; a missing
    // session (no active workflow owns it) or a token mismatch is a 401 — the
    // hook is dropped, never persisted or delivered.
    if (this.#store) {
      const expected = this.#store.resolveSessionToken(sessionName);
      const provided = req.headers.get("X-Middle-Token") ?? "";
      if (expected === null || !tokensMatch(provided, expected)) {
        console.error(`[hook-server] rejected ${event}:${sessionName} — bad or unknown token`);
        return new Response("unauthorized", { status: 401 });
      }
    }

    console.error(`[hook-server] received ${event}:${sessionName}`);
    // Persist first (the durable record), then deliver to any awaiter (the
    // fast-path signal). A store write that throws must not take down the
    // receiver, so it is best-effort.
    try {
      this.#store?.record(event, sessionName, payload);
    } catch (error) {
      console.error(`[hook-server] store.record failed for ${event}:${sessionName}: ${(error as Error).message}`);
    }
    this.#deliver(`${event}:${sessionName}`, payload);
    return new Response("ok");
  }

  #deliver(key: string, payload: HookPayload): void {
    const waiter = this.#waiters.get(key);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.#waiters.delete(key);
      waiter.resolve(payload);
    } else if (!this.#stashed.has(key)) {
      // Keep the first arrival. A duplicate fires during a retry scenario and
      // would otherwise silently overwrite the original — most acutely for
      // `session.started`, where the payload carries `session_id` /
      // `transcript_path` the workflow then commits to.
      this.#stashed.set(key, payload);
    }
  }

  #await(key: string, timeoutMs: number): Promise<HookPayload> {
    const stashed = this.#stashed.get(key);
    if (stashed) {
      this.#stashed.delete(key);
      return Promise.resolve(stashed);
    }
    return new Promise<HookPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(key);
        reject(new Error(`timed out waiting for ${key}`));
      }, timeoutMs);
      this.#waiters.set(key, { resolve, reject, timer });
    });
  }

  awaitSessionStart(sessionName: string, timeoutMs: number): Promise<HookPayload> {
    return this.#await(`session.started:${sessionName}`, timeoutMs);
  }

  awaitStop(sessionName: string, timeoutMs: number): Promise<HookPayload> {
    return this.#await(`agent.stopped:${sessionName}`, timeoutMs);
  }
}
