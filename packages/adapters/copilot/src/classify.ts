import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BlockedSentinel,
  HookPayload,
  RateLimitDetection,
  StopClassification,
} from "@middle/core";

/**
 * Copilot's rate-limit text signal. Unlike Codex (a structured `rate_limits`
 * block in the rollout), Copilot surfaces a rate limit only as message/error text
 * — per the CLI's own docs, "per-model, weekly, or integration limits" and
 * "generic 429s". We scan the transcript tail for those shapes. `429` is
 * word-boundaried (`\b429\b`) so it matches the HTTP status, not an incidental
 * substring in a tail full of line numbers, ids, and byte counts (the Codex
 * lesson — a false `rate-limited` halts a healthy agent).
 */
const RATE_LIMIT_RE = /rate.?limit|\b429\b|too many requests|quota exceeded|usage limit/i;

/**
 * Classify the agent's state at a turn-end. For Copilot the turn boundary is the
 * `sessionEnd` hook mapped to `agent.stopped` (Copilot fires no per-turn stop —
 * see `hooks.ts`). The sentinel logic is identical to Claude/Codex — the
 * `.middle/{blocked,done,failed}.json` files are written by the universal skill,
 * not the CLI, so their resolution is adapter-agnostic. Only the rate-limit read
 * differs (text-regex over the transcript tail; Copilot has no structured block).
 * All sentinel paths anchor at `<worktree>/.middle/`, never `payload.cwd` (the
 * agent may have `cd`'d into a subdirectory).
 */
export function classifyStop(opts: {
  payload: HookPayload;
  transcriptPath: string;
  sentinelPresent: boolean;
  worktree: string;
}): StopClassification {
  const middleDir = join(opts.worktree, ".middle");

  if (opts.sentinelPresent) {
    const sentinelPath = join(middleDir, "blocked.json");
    return { kind: "asked-question", sentinelPath, sentinel: readBlockedSentinel(sentinelPath) };
  }

  if (RATE_LIMIT_RE.test(readTail(opts.transcriptPath))) {
    return { kind: "rate-limited", resetAt: "unknown" };
  }

  if (existsSync(join(middleDir, "done.json"))) return { kind: "done" };

  const failedPath = join(middleDir, "failed.json");
  if (existsSync(failedPath)) {
    return { kind: "failed", reason: readFailedReason(failedPath) };
  }

  return { kind: "bare-stop" };
}

/**
 * The turn-end rate-limit detector: the same text-regex read as `classifyStop`,
 * independent of its ordering so the dispatcher can update `rate_limit_state` on
 * every stop even when the classification is a higher-priority kind. Copilot
 * exposes no structured reset time on disk, so `resetAt` is "unknown". Returns
 * null when no rate-limit signal is present.
 */
export function detectRateLimit(opts: {
  payload: HookPayload;
  transcriptPath: string;
}): RateLimitDetection | null {
  if (!RATE_LIMIT_RE.test(readTail(opts.transcriptPath))) return null;
  return { resetAt: "unknown", source: "stop-hook" };
}

function readTail(path: string): string {
  try {
    const raw = readFileSync(path, "utf8");
    return raw.length > 8192 ? raw.slice(-8192) : raw;
  } catch {
    return "";
  }
}

/**
 * Read and tolerantly parse the `.middle/blocked.json` question sentinel. Returns
 * `null` when the file is missing, unreadable, not JSON, or carries no string
 * `question`; the Stop is still classified `asked-question` (the sentinel's
 * presence is the signal), the contents are best-effort.
 */
function readBlockedSentinel(path: string): BlockedSentinel | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof parsed.question !== "string" || parsed.question.length === 0) return null;
    const context = typeof parsed.context === "string" ? parsed.context : undefined;
    const kind = parsed.kind === "complexity" ? "complexity" : undefined;
    const out: BlockedSentinel = { question: parsed.question };
    if (context !== undefined) out.context = context;
    if (kind !== undefined) out.kind = kind;
    return out;
  } catch {
    return null;
  }
}

function readFailedReason(path: string): string {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : "agent reported failure";
  } catch {
    return "agent reported failure";
  }
}
