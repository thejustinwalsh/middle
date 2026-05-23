import type { Database } from "bun:sqlite";
import type { HookPayload, NormalizedEvent } from "@middle/core";
import {
  findActiveWorkflowBySession,
  recordEvent,
  touchHeartbeat,
  updateWorkflow,
} from "./workflow-record.ts";

/**
 * The persistence + auth seam the `HookServer` calls. The server stays a
 * transport + auth layer; every SQLite write goes through a store. Decoupling
 * it this way lets the server's `SessionGate` mechanics be unit-tested without a
 * database, and lets the events/heartbeat persistence (task 15 / #18) evolve
 * without re-touching the server.
 */
export interface HookStore {
  /**
   * The expected per-session token (`session_token`) for an *active* workflow,
   * or `null` when no active workflow owns the session. The server compares it
   * timing-safely against `X-Middle-Token` to authenticate the hook, and uses a
   * `null` here as "unknown / unmatchable session → drop".
   */
  resolveSessionToken(sessionName: string): string | null;

  /**
   * Persist the event and apply its side effects: an `events` row for every
   * hook, a `last_heartbeat` bump on `tool.pre`/`tool.post`, and the
   * `session_id` + `transcript_path` write on `session.started`. Correlates to a
   * workflow by `session_name`; an unmatchable session is logged and dropped.
   */
  record(event: NormalizedEvent, sessionName: string, payload: HookPayload): void;
}

/** Payloads are truncated to this many bytes before landing in `events.payload_json`. */
const PAYLOAD_MAX_BYTES = 16 * 1024;

/** Hooks whose arrival counts as agent activity for the watchdog's freshness check. */
const HEARTBEAT_EVENTS = new Set<NormalizedEvent>(["tool.pre", "tool.post"]);

/**
 * Serialize and hard-cap a hook payload at 16KB. A transcript-laden tool.post
 * can be large; the `events` table is an audit trail, not the source of truth
 * (the on-disk transcript is), so a truncated tail is acceptable and keeps the
 * row bounded. Truncation is on the UTF-8 byte length, marked so a reader knows
 * the JSON is intentionally clipped.
 */
export function serializePayload(payload: HookPayload): string {
  const json = JSON.stringify(payload ?? {});
  if (Buffer.byteLength(json, "utf8") <= PAYLOAD_MAX_BYTES) return json;
  // Clip on a byte boundary, then mark it. The result is deliberately not valid
  // JSON — it's an audit record, and a reader must not assume it round-trips.
  const clipped = Buffer.from(json, "utf8").subarray(0, PAYLOAD_MAX_BYTES).toString("utf8");
  return `${clipped}…[truncated]`;
}

/** The SQLite-backed store the live dispatcher wires into the hook server. */
export class DbHookStore implements HookStore {
  readonly #db: Database;
  readonly #now: () => number;

  constructor(db: Database, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  resolveSessionToken(sessionName: string): string | null {
    return findActiveWorkflowBySession(this.#db, sessionName)?.sessionToken ?? null;
  }

  record(event: NormalizedEvent, sessionName: string, payload: HookPayload): void {
    const workflow = findActiveWorkflowBySession(this.#db, sessionName);
    if (!workflow) {
      // The agent (or a late retry) outlived its workflow row, or the session
      // name never matched one. Nothing to attach the event to — log and drop;
      // never throw, or a stray hook could crash the receiver.
      console.error(`[hook-store] dropping ${event}: no active workflow for session ${sessionName}`);
      return;
    }
    const now = this.#now();
    recordEvent(this.#db, {
      workflowId: workflow.id,
      ts: now,
      type: event,
      payloadJson: serializePayload(payload),
    });

    if (event === "session.started") {
      updateWorkflow(this.#db, workflow.id, {
        sessionId: typeof payload.session_id === "string" ? payload.session_id : undefined,
        transcriptPath:
          typeof payload.transcript_path === "string" ? payload.transcript_path : undefined,
      });
    }

    if (HEARTBEAT_EVENTS.has(event)) {
      touchHeartbeat(this.#db, workflow.id, now);
    }
  }
}
