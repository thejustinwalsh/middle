import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookPayload, TranscriptState } from "@middle/core";

/**
 * Locate Copilot's on-disk session transcript from the `sessionStart` hook
 * payload. Unlike Claude/Codex — which hand the dispatcher a `transcript_path` —
 * Copilot's payload carries only a (camelCase) `sessionId` + `cwd` and **no path**,
 * so we DERIVE it. Confirmed against copilot 1.0.54 (live probe): the rollout is
 * `$COPILOT_HOME/session-state/<sessionId>/events.jsonl`, and `buildLaunchCommand`
 * sets `COPILOT_HOME=<worktree>/.copilot` while `sessionStart` (source `new`)
 * reports `cwd` = the launch cwd = the worktree, so the join is exact:
 * `<cwd>/.copilot/session-state/<sessionId>/events.jsonl`.
 *
 * We read `sessionId` (camelCase, Copilot's shape) first, then `session_id`
 * (snake_case) as a defensive fallback, and throw if neither is present so a
 * payload-shape mismatch fails fast at launch→drive rather than silently reading
 * nothing. `cwd` falls back to the process cwd only if the payload omits it
 * (it never does in practice).
 */
export function resolveTranscriptPath(payload: HookPayload): string {
  const sessionId =
    typeof payload.sessionId === "string" && payload.sessionId.length > 0
      ? payload.sessionId
      : typeof payload.session_id === "string" && payload.session_id.length > 0
        ? payload.session_id
        : null;
  if (sessionId === null) {
    throw new Error("Copilot sessionStart payload has no sessionId");
  }
  // Defense-in-depth: the sessionId is a path component, so reject anything that
  // isn't a plain identifier (UUIDs and the like). A crafted value with `/` or
  // `..` would otherwise escape `<cwd>/.copilot/session-state/` via `join`. The
  // payload comes from the trusted copilot binary today, but the derivation must
  // not be the weak link if that ever changes.
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error(`Copilot sessionId is not a plain identifier: ${JSON.stringify(sessionId)}`);
  }
  const cwd =
    typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : process.cwd();
  return join(cwd, ".copilot", "session-state", sessionId, "events.jsonl");
}

type EventLine = {
  type?: string;
  timestamp?: string;
  data?: {
    toolName?: string;
    outputTokens?: number;
  };
};

/**
 * Parse Copilot's typed `events.jsonl` for activity, turn count, last tool use,
 * and a best-effort context-token estimate. Corrupt lines are skipped, not thrown
 * on — the reconciler cron is the authoritative reader; this is the fast-path
 * estimate. Schema confirmed against copilot 1.0.54 rollouts (live probe):
 *
 * - any line's ISO `timestamp` advances `lastActivity`;
 * - an `assistant.turn_end` event counts as a completed turn;
 * - a `tool.execution_start` event's `data.toolName` updates `lastToolUse`;
 * - `contextTokens` is **best-effort**: Copilot's transcript exposes per-message
 *   `outputTokens` but no cumulative input/context fill (that lives only in the
 *   OTEL `gen_ai.client.token.usage` metric), and Copilot self-manages context via
 *   checkpoints. We surface the last assistant message's `outputTokens` as a coarse
 *   monotone proxy; the load-bearing watchdog signals (`lastActivity`,
 *   `lastToolUse`) are exact. See `planning/issues/124/decisions.md`.
 */
export function readTranscriptState(transcriptPath: string): TranscriptState {
  const raw = readFileSync(transcriptPath, "utf8");
  let lastActivity = "";
  let turnCount = 0;
  let lastToolUse: string | null = null;
  let contextTokens = 0;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let entry: EventLine;
    try {
      entry = JSON.parse(trimmed) as EventLine;
    } catch {
      continue;
    }
    if (typeof entry.timestamp === "string") lastActivity = entry.timestamp;

    if (entry.type === "assistant.turn_end") turnCount++;
    if (entry.type === "tool.execution_start" && typeof entry.data?.toolName === "string") {
      lastToolUse = entry.data.toolName;
    }
    if (entry.type === "assistant.message" && typeof entry.data?.outputTokens === "number") {
      contextTokens = entry.data.outputTokens;
    }
  }

  return { lastActivity, contextTokens, turnCount, lastToolUse };
}
