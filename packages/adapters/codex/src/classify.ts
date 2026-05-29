import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BlockedSentinel,
  HookPayload,
  RateLimitDetection,
  StopClassification,
} from "@middle/core";

/**
 * Codex's textual rate-limit fallback. The structured `rate_limits` block in the
 * rollout (below) is the primary, precise signal; this regex catches any
 * message-shaped rate-limit text that surfaces without a structured block.
 * `429` is word-boundaried (`\b429\b`) so it matches the HTTP status, not an
 * incidental substring — a transcript tail is full of line numbers, hashes, and
 * byte counts ("line 4290", "commit 4291ab"), and a false `rate-limited` would
 * halt a healthy agent.
 */
const RATE_LIMIT_RE = /rate.?limit|\b429\b|too many requests/i;

type RateLimitWindow = { used_percent?: number; resets_at?: number };
type RateLimits = {
  rate_limit_reached_type?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
};

/**
 * Read the most recent `token_count` event's `rate_limits` block from the
 * rollout. Codex 0.133.0 emits, on every turn, an `event_msg` of
 * `type: "token_count"` whose `payload.rate_limits` carries
 * `rate_limit_reached_type` (null when healthy), a `primary`/`secondary` window
 * with `used_percent`, and an epoch `resets_at`. We scan line-by-line and keep
 * the last one — corrupt lines are skipped, not thrown on (the reconciler cron
 * is the authoritative reader; this is the fast-path estimate). Returns null
 * when the rollout has no rate-limit block (or can't be read).
 */
function readLatestRateLimits(path: string): RateLimits | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let latest: RateLimits | null = null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || !trimmed.includes("rate_limits")) continue;
    let entry: { payload?: { type?: string; rate_limits?: RateLimits } };
    try {
      entry = JSON.parse(trimmed) as typeof entry;
    } catch {
      continue;
    }
    const rl = entry.payload?.rate_limits;
    if (entry.payload?.type === "token_count" && rl) latest = rl;
  }
  return latest;
}

/** Convert an epoch-seconds `resets_at` to ISO, or "unknown" when absent/invalid. */
function resetAtToIso(resetsAt: number | undefined): string {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) return "unknown";
  return new Date(resetsAt * 1000).toISOString();
}

/**
 * The shared rate-limit reader for both `classifyStop` and `detectRateLimit`:
 * structured first (the real `rate_limits` block), text-regex fallback second.
 * A rate limit is "reached" when `rate_limit_reached_type` is non-null OR a
 * window is at/over 100% used. The reset timestamp prefers the window that
 * tripped (else `primary`), falling back to the transcript text only when no
 * structured block is present at all. Returns null when neither signal fires.
 */
function detectRateLimitState(transcriptPath: string): { resetAt: string } | null {
  const rl = readLatestRateLimits(transcriptPath);
  if (rl) {
    const reached =
      (rl.rate_limit_reached_type != null && rl.rate_limit_reached_type !== "") ||
      (rl.primary?.used_percent ?? 0) >= 100 ||
      (rl.secondary?.used_percent ?? 0) >= 100;
    if (reached) {
      // Prefer the window actually at/over the limit for the reset time.
      const tripped =
        (rl.primary?.used_percent ?? 0) >= 100
          ? rl.primary
          : (rl.secondary?.used_percent ?? 0) >= 100
            ? rl.secondary
            : (rl.primary ?? rl.secondary);
      return { resetAt: resetAtToIso(tripped?.resets_at) };
    }
    // A healthy structured block is authoritative: not rate-limited. (We still
    // fall through to the text regex only when there was NO structured block.)
    return null;
  }
  if (RATE_LIMIT_RE.test(readTail(transcriptPath))) return { resetAt: "unknown" };
  return null;
}

/**
 * Classify the agent's state at a turn-end (`Stop`) hook. The sentinel logic is
 * identical to Claude's — the `.middle/{blocked,done,failed}.json` files are
 * written by the universal skill, not the CLI, so their resolution is
 * adapter-agnostic. Only the rate-limit detection differs (Codex reads the
 * structured `rate_limits` block in its rollout). All sentinel paths anchor at
 * `<worktree>/.middle/`, never `payload.cwd` (the agent may have `cd`'d into a
 * subdirectory).
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

  const rateLimit = detectRateLimitState(opts.transcriptPath);
  if (rateLimit) return { kind: "rate-limited", resetAt: rateLimit.resetAt };

  if (existsSync(join(middleDir, "done.json"))) return { kind: "done" };

  const failedPath = join(middleDir, "failed.json");
  if (existsSync(failedPath)) {
    return { kind: "failed", reason: readFailedReason(failedPath) };
  }

  return { kind: "bare-stop" };
}

/**
 * The turn-end rate-limit detector: the same structured-first read as
 * `classifyStop`, independent of its ordering so the dispatcher can update
 * `rate_limit_state` on every stop even when the classification is a
 * higher-priority kind. Returns null when no rate-limit signal is present.
 */
export function detectRateLimit(opts: {
  payload: HookPayload;
  transcriptPath: string;
}): RateLimitDetection | null {
  const rateLimit = detectRateLimitState(opts.transcriptPath);
  if (!rateLimit) return null;
  return { resetAt: rateLimit.resetAt, source: "stop-hook" };
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
