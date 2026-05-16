import { readFileSync } from "node:fs";
import type { HookPayload, TranscriptState } from "@middle/core";

/** Claude delivers `transcript_path` directly in the SessionStart hook payload. */
export function resolveTranscriptPath(payload: HookPayload): string {
  const path = payload.transcript_path;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("SessionStart payload has no transcript_path");
  }
  return path;
}

type TranscriptLine = {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    usage?: Record<string, number>;
  };
};

function isToolUseBlock(block: unknown): block is { type: "tool_use"; name?: string } {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: string }).type === "tool_use"
  );
}

/**
 * Parse the JSONL transcript for activity, turn count, last tool use, and
 * context-token usage. Corrupt lines are skipped rather than thrown on — the
 * transcript reconciler cron (Phase 2) is the authoritative reader; this is the
 * fast-path estimate. `contextTokens` is the input side of the last assistant
 * turn (prompt + cache), i.e. how full the context window is.
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
    let entry: TranscriptLine;
    try {
      entry = JSON.parse(trimmed) as TranscriptLine;
    } catch {
      continue;
    }
    if (typeof entry.timestamp === "string") lastActivity = entry.timestamp;
    if (entry.type !== "assistant") continue;

    turnCount++;
    const content = entry.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (isToolUseBlock(block) && typeof block.name === "string") {
          lastToolUse = block.name;
        }
      }
    }
    const usage = entry.message?.usage;
    if (usage) {
      contextTokens =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
    }
  }

  return { lastActivity, contextTokens, turnCount, lastToolUse };
}
