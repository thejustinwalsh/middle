import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BlockedSentinel,
  HookPayload,
  RateLimitDetection,
  StopClassification,
} from "@middle/core";

const USAGE_LIMIT_RE = /You've hit your usage limit\. Resets at (.+?)\./;

/**
 * Classify the agent's state at a `Stop` hook. The interactive process does not
 * exit between turns, so this — not an exit code — is the signal the workflow
 * reacts to. Order matters: an open question outranks everything else.
 *
 * All three sentinel paths are anchored at `<worktree>/.middle/`, not at
 * `payload.cwd`. The Claude session's `cwd` at Stop time may be a subdirectory
 * the agent has `cd`'d into (e.g. `worktree/src/`); only the worktree root is
 * the stable home of the workstream's sentinel files.
 *
 * Phase 1 detects `done`/`failed` via `.middle/done.json` / `.middle/failed.json`
 * sentinels, parallel to the `.middle/blocked.json` question sentinel. Phase 4
 * replaces the `done` path with the mechanically-enforced PR-ready hook gate.
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

  const match = USAGE_LIMIT_RE.exec(readTail(opts.transcriptPath));
  if (match) return { kind: "rate-limited", resetAt: match[1]! };

  if (existsSync(join(middleDir, "done.json"))) return { kind: "done" };

  const failedPath = join(middleDir, "failed.json");
  if (existsSync(failedPath)) {
    return { kind: "failed", reason: readFailedReason(failedPath) };
  }

  return { kind: "bare-stop" };
}

/**
 * The Stop-hook rate-limit detector: the same usage-limit regex applied to the
 * `Stop` hook's transcript tail, independent of the `classifyStop` ordering (so
 * the dispatcher can update `rate_limit_state` immediately on every Stop, even
 * when `classifyStop` returns a higher-priority classification like an open
 * question). Returns null when no usage-limit message is present.
 */
export function detectRateLimit(opts: {
  payload: HookPayload;
  transcriptPath: string;
}): RateLimitDetection | null {
  const match = USAGE_LIMIT_RE.exec(readTail(opts.transcriptPath));
  if (!match) return null;
  return { resetAt: match[1]!, source: "stop-hook" };
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
 * Read and tolerantly parse the `.middle/blocked.json` question sentinel so the
 * workflow can surface the agent's question (and any context) to the human —
 * e.g. posted on the Epic when it parks on `asked-question`. Returns `null` when
 * the file is missing, unreadable, not JSON, or carries no string `question`:
 * the Stop is still classified `asked-question` (the sentinel's *presence* is
 * the signal), the contents are just best-effort.
 */
function readBlockedSentinel(path: string): BlockedSentinel | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof parsed.question !== "string" || parsed.question.length === 0) return null;
    const context = typeof parsed.context === "string" ? parsed.context : undefined;
    // Only "complexity" is a recognized non-default kind; anything else (or
    // absent) is a plain question.
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
