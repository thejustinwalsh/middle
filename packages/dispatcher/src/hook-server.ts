import { timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";
import type { HookPayload, NormalizedEvent } from "@middle/core";
import { isNormalizedEvent } from "@middle/core";
import type { Event, EventHub } from "./event-hub.ts";
import type { PrReadyGateHandler } from "./gates/pr-ready-handler.ts";
import type { HookStore } from "./hook-store.ts";

type BunServer = ReturnType<typeof Bun.serve>;

/** The validated `POST /control/dispatch` body — `repoPath` lets the daemon locate the checkout. */
export type ControlDispatchInput = {
  repo: string;
  repoPath: string;
  epicNumber: number;
  adapter: string;
};

/**
 * The control plane the dispatcher server exposes to operator-local HTTP
 * clients (`mm dispatch`, later the dashboard). Injected and optional: gate-only
 * mode (no control) keeps `/hooks` + `/gates` working and 404s the control
 * routes. All collaborators are seams so the routes unit-test without a real
 * engine or db — the daemon (#113) binds the live engine, hub, and db queries.
 */
export type ControlPlane = {
  /** The SSE hub served at `/control/events`. */
  hub: EventHub;
  /** Reported by `/health` so a client can confirm compatibility. */
  version: string;
  /** Whether `name` is a dispatchable adapter (body validation). */
  knownAdapter: (name: string) => boolean;
  /**
   * Whether the Epic already has a non-terminal workflow row — the 409 collision
   * guard (a second run would clash on the deterministic tmux session + worktree).
   */
  hasActiveEpicWorkflow: (repo: string, epicNumber: number) => boolean;
  /** Start a dispatch on the daemon's long-lived engine; resolves the workflow id. */
  startDispatch: (input: ControlDispatchInput) => Promise<string>;
  /** Init-replay events for a fresh `/control/events` subscriber (in-flight rows). */
  initEvents?: () => Event[];
};

/**
 * The dashboard-facing "run the recommender now" trigger. Given the requested
 * repo, it kicks off a recommender run and returns an HTTP status + body. Wired
 * by the dispatcher; absent in gate-only mode (the route then 404s). The
 * dashboard UI itself lands in Phase 9 — this is the dispatcher endpoint it
 * will POST to (build spec → Phase 7: "Run-recommender CLI + dashboard button").
 */
export type RecommenderTrigger = (req: {
  repoSlug?: string;
  repoPath?: string;
}) => Promise<{ status: number; body: string }>;

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
  readonly #prReadyGate: PrReadyGateHandler | undefined;
  readonly #recommenderTrigger: RecommenderTrigger | undefined;
  readonly #control: ControlPlane | undefined;

  constructor(
    store?: HookStore,
    prReadyGate?: PrReadyGateHandler,
    recommenderTrigger?: RecommenderTrigger,
    control?: ControlPlane,
  ) {
    this.#store = store;
    this.#prReadyGate = prReadyGate;
    this.#recommenderTrigger = recommenderTrigger;
    this.#control = control;
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
    const pathname = new URL(req.url).pathname;
    // Liveness — unconditional, no DB access, so a client can probe for the daemon.
    if (req.method === "GET" && pathname === "/health") {
      return Response.json({ ok: true, port: this.port, version: this.#control?.version ?? "" });
    }
    if (req.method === "GET" && pathname === "/control/events") {
      return this.#handleControlEvents(req);
    }
    if (req.method === "POST" && pathname === "/control/dispatch") {
      return this.#handleControlDispatch(req);
    }
    if (req.method === "POST" && pathname === "/gates/pr-ready") {
      return this.#handleGate(req);
    }
    if (req.method === "POST" && pathname === "/trigger/recommender") {
      return this.#handleRecommenderTrigger(req);
    }
    const match = /^\/hooks\/(.+)$/.exec(pathname);
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

  /**
   * The PR-ready guard endpoint. The `gh pr ready` PreToolUse hook POSTs its
   * payload here; the dispatcher decides whether the Epic PR's acceptance
   * criteria are all evidenced. 200 = allow (the hook exits 0), 403 + reason =
   * deny (the hook prints the reason to stderr and exits 2, blocking the tool).
   *
   * Authenticated identically to `/hooks` when a store is wired: a missing
   * session or bad token is a 401 (the hook fails open on connection errors, not
   * on a 4xx — a wedged auth is surfaced as the deny reason).
   */
  async #handleGate(req: Request): Promise<Response> {
    if (!this.#prReadyGate) return new Response("not found", { status: 404 });

    let payload: HookPayload = {};
    try {
      payload = (await req.json()) as HookPayload;
    } catch {
      // tolerate a garbled body — the command match will simply not fire
    }
    const sessionName =
      req.headers.get("X-Middle-Session") ??
      (typeof payload.sessionName === "string" ? payload.sessionName : "");
    if (sessionName === "") {
      return new Response("missing session", { status: 400 });
    }

    if (this.#store) {
      const expected = this.#store.resolveSessionToken(sessionName);
      const provided = req.headers.get("X-Middle-Token") ?? "";
      if (expected === null || !tokensMatch(provided, expected)) {
        return new Response("unauthorized", { status: 401 });
      }
    }

    const decision = await this.#prReadyGate({ sessionName, payload });
    if (decision.decision === "allow") return new Response("allow");
    console.error(`[hook-server] pr-ready gate DENY for ${sessionName}: ${decision.reason}`);
    return new Response(decision.reason, { status: 403 });
  }

  /**
   * The dashboard's "run the recommender now" endpoint. 404 when no trigger is
   * wired (gate-only mode). Read-only at this phase: the run rewrites the state
   * issue but dispatches nothing. Returns the trigger's status/body verbatim.
   */
  async #handleRecommenderTrigger(req: Request): Promise<Response> {
    if (!this.#recommenderTrigger) return new Response("not found", { status: 404 });
    let parsed: unknown;
    try {
      parsed = await req.json();
    } catch {
      // tolerate an empty/garbled body — the trigger validates its own inputs
    }
    // The body is untrusted JSON. First narrow the *container*: a bare primitive,
    // array, or the literal `null` (all of which `req.json()` parses successfully)
    // is not a field bag — treat it as empty rather than dereferencing it. Then
    // pass a field through only when it is actually a string; anything else
    // becomes `undefined` so it can't masquerade as a `repoSlug`/`repoPath` and
    // fail deeper as a 500.
    const body: Record<string, unknown> =
      typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
    const result = await this.#recommenderTrigger({
      repoSlug: str(body.repoSlug),
      repoPath: str(body.repoPath),
    });
    return new Response(result.body, { status: result.status });
  }

  /**
   * `GET /control/events` — the SSE feed of workflow state. 404 in gate-only
   * mode. A fresh subscriber gets a `connected` frame, the injected init-replay
   * (in-flight rows), then live broadcasts. Operator-local: no token (the server
   * is 127.0.0.1-only).
   */
  #handleControlEvents(req: Request): Response {
    const control = this.#control;
    if (!control) return new Response("not found", { status: 404 });
    return control.hub.serve(req, control.initEvents?.() ?? []);
  }

  /**
   * `POST /control/dispatch` — enqueue an Epic on the daemon's engine. Validates
   * the body (non-empty `repo`, absolute `repoPath`, integer `epicNumber >= 1`,
   * known `adapter`) → 400 on any failure; rejects with 409 if the Epic already
   * has a non-terminal workflow (a colliding tmux session + worktree). 404 in
   * gate-only mode. On success returns `{ workflowId }`.
   */
  async #handleControlDispatch(req: Request): Promise<Response> {
    const control = this.#control;
    if (!control) return new Response("not found", { status: 404 });

    let parsed: unknown;
    try {
      parsed = await req.json();
    } catch {
      return this.#badRequest("body must be valid JSON");
    }
    const body: Record<string, unknown> =
      typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};

    const { repo, repoPath, epicNumber, adapter } = body;
    if (typeof repo !== "string" || repo === "") {
      return this.#badRequest("repo must be a non-empty string");
    }
    if (typeof repoPath !== "string" || !isAbsolute(repoPath)) {
      return this.#badRequest("repoPath must be an absolute path");
    }
    if (typeof epicNumber !== "number" || !Number.isInteger(epicNumber) || epicNumber < 1) {
      return this.#badRequest("epicNumber must be an integer >= 1");
    }
    if (typeof adapter !== "string" || !control.knownAdapter(adapter)) {
      return this.#badRequest(`unknown adapter: ${typeof adapter === "string" ? adapter : "(missing)"}`);
    }

    if (control.hasActiveEpicWorkflow(repo, epicNumber)) {
      return Response.json(
        { error: `Epic #${epicNumber} in ${repo} already has an active workflow` },
        { status: 409 },
      );
    }

    const workflowId = await control.startDispatch({ repo, repoPath, epicNumber, adapter });
    return Response.json({ workflowId });
  }

  #badRequest(reason: string): Response {
    return Response.json({ error: reason }, { status: 400 });
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
