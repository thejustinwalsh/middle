/**
 * A minimal SSE broadcast hub — the control plane's live fan-out. Ported from
 * `restruct`'s server-side hub (`cli/internal/server/sse/hub.go`): subscribers
 * connect, get a `connected` frame, an init-replay so a late joiner catches up,
 * then live broadcasts; a periodic heartbeat keeps the connection warm and a
 * slow/full consumer is dropped rather than back-pressuring the broadcaster.
 *
 * Deliberately engine-free so it unit-tests in isolation and the dashboard
 * (#57) can reuse it. The daemon (#113) wires `broadcast` to workflow state
 * transitions and sources init events from in-flight workflow rows.
 */

/** A broadcast event. `data` is JSON-serialized into the SSE `data:` line. */
export type Event = { type: string; data: unknown };

/**
 * The `state` carried on a `workflow` event. It is the explicit union of the two
 * vocabularies a consumer must understand: bunqueue's execution lifecycle
 * (`running`, `waiting`, `compensating`, `completed`, `failed`) and middle's
 * DB-only workflow states (`pending`, `launching`, `waiting-human`,
 * `rate-limited`, `compensated`, `cancelled`). Kept in sync with `WorkflowState`
 * in `workflow-record.ts` and bunqueue's `ExecutionState` — narrowing it here
 * keeps the control-plane contract honest (an invalid state fails type-check).
 */
export type WorkflowWireState =
  | "pending"
  | "launching"
  | "running"
  | "waiting"
  | "waiting-human"
  | "rate-limited"
  | "completed"
  | "compensating"
  | "compensated"
  | "failed"
  | "cancelled";

/** The data shape carried by a `workflow` event (the only producer today). */
export type WorkflowEventData = {
  id: string;
  repo: string;
  epic: number | null;
  state: WorkflowWireState;
};

/** SSE comment line — ignored by `EventSource`, but flushes/keeps the socket alive. */
const HEARTBEAT_FRAME = ": heartbeat\n\n";

/** Default per-subscriber buffer depth before a slow consumer is dropped. */
const DEFAULT_MAX_BUFFER = 256;

/**
 * Default heartbeat cadence — matches `restruct`'s 15s hub ticker. Exported so
 * the server hosting the SSE can size its connection idle-timeout above it (a
 * heartbeat that fires *after* the socket idle-timeout is useless — the socket
 * is already closed).
 */
export const DEFAULT_HEARTBEAT_MS = 15_000;

/** Encode an {@link Event} as a single SSE frame. */
function encodeEvent(event: Event): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/**
 * One connected client. Wraps a `ReadableStream` controller and bounds its
 * buffer: `write` returns `false` once the consumer has fallen `maxBuffer`
 * frames behind (drop-on-full) or the stream has closed, and the hub then
 * unsubscribes it. `close` ends the stream idempotently.
 */
class Subscriber {
  #closed = false;
  readonly #encoder = new TextEncoder();

  constructor(
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
    private readonly maxBuffer: number,
  ) {}

  write(frame: string): boolean {
    if (this.#closed) return false;
    // `desiredSize` is `highWaterMark - queued` under a CountQueuingStrategy;
    // `<= 0` means the consumer is `maxBuffer` frames behind → drop, don't block.
    const room = this.controller.desiredSize;
    if (room !== null && room <= 0) return false;
    try {
      this.controller.enqueue(this.#encoder.encode(frame));
      return true;
    } catch {
      // The stream was already cancelled/closed out from under us.
      this.#closed = true;
      return false;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.controller.close();
    } catch {
      // already closed / errored — nothing to do
    }
  }
}

/** Options for an {@link EventHub}. */
export type EventHubOptions = {
  /** Heartbeat cadence in ms (default 15000). Lower it in tests. */
  heartbeatMs?: number;
  /** Per-subscriber buffer depth before drop-on-full (default 256). */
  maxBuffer?: number;
};

/**
 * The control plane's live SSE fan-out. One hub serves many `/control/events`
 * subscribers; the daemon is the sole producer.
 *
 * Contract:
 * - `serve(req, initEvents)` returns the SSE `Response` for one subscriber: a
 *   `connected` frame, the init-replay, then live broadcasts. Aborting the
 *   request (or cancelling the body) only unsubscribes — never the engine.
 * - `broadcast(event)` fans out to every current subscriber; a consumer that
 *   has fallen `maxBuffer` frames behind is dropped rather than back-pressuring
 *   the broadcaster (delivery is best-effort, not guaranteed).
 * - The heartbeat self-arms on the first subscriber and stops with the last, so
 *   an idle hub holds no timer (and the timer never keeps the process alive).
 *
 * Not safe for true parallelism, but JS is single-threaded; all methods are
 * synchronous and reentrancy-safe (fan-out snapshots the subscriber set).
 */
export class EventHub {
  readonly #subscribers = new Set<Subscriber>();
  readonly #heartbeatMs: number;
  readonly #maxBuffer: number;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: EventHubOptions = {}) {
    this.#heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  }

  /** Live subscriber count — for observability and tests. */
  subscriberCount(): number {
    return this.#subscribers.size;
  }

  /** Register a subscriber and (re)arm the heartbeat. */
  subscribe(sub: Subscriber): void {
    this.#subscribers.add(sub);
    this.#ensureHeartbeat();
  }

  /** Remove a subscriber, close its stream, and stop the heartbeat if it was the last. */
  unsubscribe(sub: Subscriber): void {
    if (!this.#subscribers.delete(sub)) return;
    sub.close();
    if (this.#subscribers.size === 0) this.#stopHeartbeat();
  }

  /** Fan an event out to every subscriber; drop any that have overflowed. */
  broadcast(event: Event): void {
    const frame = encodeEvent(event);
    this.#fanOut(frame);
  }

  /**
   * Build the SSE `Response` for a new subscriber: a `connected` frame, then a
   * replay of `initEvents` (so a late joiner catches up to current state), then
   * live broadcasts. Aborting `req.signal` (or cancelling the body) only
   * unsubscribes — it never touches any engine or workflow.
   */
  serve(req: Request, initEvents: Event[] = []): Response {
    let sub: Subscriber | undefined;
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          sub = new Subscriber(controller, this.#maxBuffer);
          this.subscribe(sub);
          sub.write(encodeEvent({ type: "connected", data: {} }));
          for (const event of initEvents) sub.write(encodeEvent(event));
        },
        cancel: () => {
          if (sub) this.unsubscribe(sub);
        },
      },
      new CountQueuingStrategy({ highWaterMark: this.#maxBuffer }),
    );
    // A client that aborted between the request landing and the stream starting
    // would never fire `abort` again (the listener only catches future aborts),
    // so reap it immediately; otherwise watch for a later disconnect.
    if (req.signal.aborted) {
      if (sub) this.unsubscribe(sub);
    } else {
      req.signal.addEventListener("abort", () => {
        if (sub) this.unsubscribe(sub);
      });
    }
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  }

  #fanOut(frame: string): void {
    // `unsubscribe` deletes the current subscriber mid-iteration; removing the
    // element a `for…of` over a Set is currently visiting is safe and does not
    // disturb the walk, so no snapshot is needed.
    for (const sub of this.#subscribers) {
      if (!sub.write(frame)) this.unsubscribe(sub);
    }
  }

  #ensureHeartbeat(): void {
    if (this.#heartbeatTimer !== null) return;
    this.#heartbeatTimer = setInterval(() => this.#fanOut(HEARTBEAT_FRAME), this.#heartbeatMs);
    // Don't let the heartbeat alone keep the process alive.
    (this.#heartbeatTimer as { unref?: () => void }).unref?.();
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer === null) return;
    clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
  }
}
