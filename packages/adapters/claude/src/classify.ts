import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookPayload, StopClassification } from "@middle/core";

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
    return { kind: "asked-question", sentinelPath: join(middleDir, "blocked.json") };
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

function readTail(path: string): string {
  try {
    const raw = readFileSync(path, "utf8");
    return raw.length > 8192 ? raw.slice(-8192) : raw;
  } catch {
    return "";
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
