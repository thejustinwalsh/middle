import { readFileSync } from "node:fs";
import type { HookPayload, TranscriptState } from "@middle/core";

/**
 * Locate Codex's on-disk session transcript (the "rollout" JSONL) from the
 * `SessionStart` hook payload. Confirmed against codex 0.133.0: the payload key
 * is `transcript_path` (Claude-identical), pointing at
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. We try
 * `transcript_path` first, accept `rollout_path` as a secondary, and throw if
 * neither is present so a payload-shape mismatch fails fast at launch→drive
 * rather than silently reading nothing.
 */
export function resolveTranscriptPath(payload: HookPayload): string {
  for (const key of ["transcript_path", "rollout_path", "session_file", "path"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  throw new Error("Codex startup payload has no transcript/rollout path");
}

type RolloutLine = {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    name?: string;
    info?: { total_token_usage?: Record<string, number> };
  };
};

/**
 * Parse Codex's rollout JSONL for activity, turn count, last tool use, and
 * context-token usage. Corrupt lines are skipped, not thrown on — the reconciler
 * cron is the authoritative reader; this is the fast-path estimate.
 *
 * The schema is confirmed against codex 0.133.0 rollouts. We read tolerantly:
 * - `timestamp` on any line advances `lastActivity`.
 * - an assistant `message` response item counts as a turn.
 * - a `function_call` response item (e.g. `name: "exec_command"`) — and the
 *   `local_shell_call` variant — updates `lastToolUse`.
 * - a `token_count` event's `info.total_token_usage` (input + cached) is the
 *   context fill.
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
    let entry: RolloutLine;
    try {
      entry = JSON.parse(trimmed) as RolloutLine;
    } catch {
      continue;
    }
    if (typeof entry.timestamp === "string") lastActivity = entry.timestamp;

    const p = entry.payload;
    if (!p) continue;

    if (p.type === "message" && p.role === "assistant") turnCount++;
    if (
      (p.type === "function_call" || p.type === "local_shell_call") &&
      typeof p.name === "string"
    ) {
      lastToolUse = p.name;
    }
    const usage = p.info?.total_token_usage;
    if (usage) {
      contextTokens = (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0);
    }
  }

  return { lastActivity, contextTokens, turnCount, lastToolUse };
}
