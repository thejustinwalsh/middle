/**
 * The normalized event vocabulary every adapter emits. The per-CLI hook script
 * maps its native hook names onto these; the dispatcher only ever sees these.
 * Source of truth: build spec → "Normalized event taxonomy".
 */
export type NormalizedEvent =
  | "session.started"
  | "turn.started"
  | "tool.pre"
  | "tool.post"
  | "tool.failed"
  | "agent.notification"
  | "agent.stopped"
  | "session.ended"
  | "rate-limit.detected";

/**
 * The JSON body a hook delivers. Shape is per-CLI, so this is an open record;
 * the fields below are the ones middle relies on across adapters. The
 * `SessionStart` payload is load-bearing — it carries `session_id` and
 * `transcript_path`, which is how the dispatcher discovers the transcript.
 */
export type HookPayload = Record<string, unknown> & {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
};

/** What the universal `hook.sh` POSTs to the dispatcher per fired hook. */
export type HookEnvelope = {
  type: NormalizedEvent;
  sessionName: string;
  payload: HookPayload;
};
