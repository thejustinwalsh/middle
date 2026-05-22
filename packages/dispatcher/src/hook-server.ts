import type { HookPayload } from "@middle/core";

type BunServer = ReturnType<typeof Bun.serve>;

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
 * Phase 1 minimal hook receiver. It handles only the two load-bearing events —
 * `session.started` (carries `session_id` + `transcript_path`, signals
 * readiness) and `agent.stopped` (the turn boundary) — with no HMAC auth and no
 * events-table persistence. Phase 2 expands this to the full taxonomy.
 *
 * Payloads that arrive before anyone is waiting are stashed and handed to the
 * next awaiter, so a fast hook cannot race ahead of the workflow step.
 */
export class HookServer implements SessionGate {
  #server: BunServer | undefined;
  readonly #waiters = new Map<string, Waiter>();
  readonly #stashed = new Map<string, HookPayload>();

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
    const event = match[1]!;
    let payload: HookPayload = {};
    try {
      payload = (await req.json()) as HookPayload;
    } catch {
      // tolerate an empty/garbled body — the hook still signals the event fired
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
    console.error(`[hook-server] received ${event}:${sessionName}`);
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
