import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { TranscriptState } from "@middle/core";
import {
  armWaitForSignal,
  firstEventTs,
  hasEventOfType,
  isWaitForArmed,
  latestEventType,
  recordEvent,
  updateWorkflow,
} from "./workflow-record.ts";

/**
 * The watchdog is the safety net behind the hook stream. Hooks (and the
 * transcript) update activity first; the watchdog only ever acts on
 * **staleness** — it never overrides an in-progress decision a hook is making.
 * It reconciles every `launching`/`running` workflow on a fixed cadence:
 *
 *   1. launch-timeout — a `launching` workflow that never reached `running`
 *      (no `session.started` arrived) within the launch window is
 *      `stuck-launching`; a `running` workflow that went ready but whose driven
 *      prompt never landed (no `turn.started` within the window) is
 *      `prompt-not-accepted`.
 *   2. tmux liveness — a `running` workflow whose session has died is failed
 *      (`tmux session disappeared`) and compensation is triggered.
 *   3. activity freshness — `now − freshest(activity)`, cross-checked against
 *      the on-disk transcript (the interactive process never self-terminates,
 *      so staleness is the primary stuck-agent detector). Idle ≥ threshold marks
 *      an `idle` event; ≥ kill-threshold kills the session and fails the
 *      workflow (`idle-timeout`). **Skipped while `controlled_by = 'human'`.**
 *   4. sentinel — a `<worktree>/.middle/blocked.json` with no armed `waitFor`
 *      signal re-arms the signal (handles the agent-wrote-after-advance race).
 *
 * A companion pass (`reconcileTranscriptDrift`) re-reads each running
 * workflow's transcript and corrects heartbeat drift — the transcript is the
 * source of truth, hooks are the fast path.
 *
 * Source of truth: build spec → "Watchdog".
 */

export type WatchdogTmux = {
  status(sessionName: string): Promise<{ alive: boolean; paneCount: number }>;
  killSession(sessionName: string): Promise<void>;
};

export type WatchdogDeps = {
  db: Database;
  tmux: WatchdogTmux;
  /** Per-adapter transcript reader — only `readTranscriptState` is used. */
  getAdapter: (name: string) => { readTranscriptState(path: string): TranscriptState };
  now?: () => number;
  launchTimeoutMs?: number;
  idleThresholdMs?: number;
  idleKillThresholdMs?: number;
  /** Engine-side rollback hook; invoked when the watchdog fails a workflow. */
  triggerCompensation?: (workflowId: string, reason: string) => void;
  /** Override the blocked-sentinel path resolver (tests). */
  blockedSentinelPath?: (worktreePath: string) => string;
};

const DEFAULT_LAUNCH_TIMEOUT_MS = 90_000;
const DEFAULT_IDLE_THRESHOLD_MS = 5 * 60 * 1000;
const DEFAULT_IDLE_KILL_THRESHOLD_MS = 15 * 60 * 1000;

/** Event type written when the watchdog marks a workflow idle (dashboard yellow). */
export const IDLE_EVENT = "watchdog.idle";
/** Event type written when the watchdog fails a workflow; payload carries the reason. */
export const FAILED_EVENT = "watchdog.failed";
/**
 * Event type written when the watchdog idle-kills a session that left a
 * `blocked.json` sentinel: instead of failing/compensating, it kills the hung
 * session so the drive's liveness race wakes and parks it for human resume.
 */
export const BLOCKED_HANDOFF_EVENT = "watchdog.blocked-handoff";

type ReconcilableRow = {
  id: string;
  state: string;
  adapter: string;
  session_name: string | null;
  worktree_path: string | null;
  transcript_path: string | null;
  last_heartbeat: number | null;
  updated_at: number;
  controlled_by: string;
};

function loadReconcilable(db: Database): ReconcilableRow[] {
  return db
    .query(
      `SELECT id, state, adapter, session_name, worktree_path, transcript_path,
              last_heartbeat, updated_at, controlled_by
         FROM workflows
        WHERE state IN ('launching', 'running')`,
    )
    .all() as ReconcilableRow[];
}

/** Last-activity timestamp (ms) from the transcript, or null if unreadable. */
function transcriptActivityMs(
  deps: WatchdogDeps,
  adapter: string,
  transcriptPath: string | null,
): number | null {
  if (!transcriptPath) return null;
  try {
    const { lastActivity } = deps.getAdapter(adapter).readTranscriptState(transcriptPath);
    const ms = Date.parse(lastActivity);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    // Missing/corrupt transcript is not an activity signal — fall back to hooks.
    return null;
  }
}

function failWorkflow(deps: WatchdogDeps, id: string, reason: string, now: number): void {
  updateWorkflow(deps.db, id, { state: "failed" });
  recordEvent(deps.db, {
    workflowId: id,
    ts: now,
    type: FAILED_EVENT,
    payloadJson: JSON.stringify({ reason }),
  });
  deps.triggerCompensation?.(id, reason);
}

/**
 * Best-effort session kill. The kill always runs *after* we've already decided
 * to fail the workflow, so a kill error must not prevent recording that failure
 * (or abort the reconciliation pass for other rows) — swallow and log it.
 */
async function safeKillSession(tmux: WatchdogTmux, sessionName: string): Promise<void> {
  try {
    await tmux.killSession(sessionName);
  } catch (error) {
    console.error(`[watchdog] killSession failed for ${sessionName}: ${(error as Error).message}`);
  }
}

/**
 * One reconciliation pass. Returns the number of workflows it acted on (a
 * convenience for logging/tests); all effects are applied to the db + tmux.
 */
export async function runWatchdog(deps: WatchdogDeps): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const launchTimeout = deps.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  const idleThreshold = deps.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  const idleKill = deps.idleKillThresholdMs ?? DEFAULT_IDLE_KILL_THRESHOLD_MS;
  const sentinelPath =
    deps.blockedSentinelPath ?? ((wt: string) => join(wt, ".middle", "blocked.json"));

  let acted = 0;
  for (const row of loadReconcilable(deps.db)) {
    // 1. launch-timeout: still 'launching' past the window → never went ready.
    if (row.state === "launching") {
      if (now - row.updated_at >= launchTimeout) {
        failWorkflow(deps, row.id, "stuck-launching", now);
        acted++;
      }
      continue;
    }

    // 2. tmux liveness — a dead session under a 'running' workflow. A status
    // *error* is inconclusive (not a confirmed-dead signal), so we only skip the
    // liveness check (leaving status null), NOT the rest of the row's durable
    // checks — falling through to rule 3 (activity freshness) is what lets the
    // wall-clock backstop still idle-timeout a row whose status() keeps erroring.
    // The per-call guards also keep one bad tmux call from aborting the pass.
    let status: { alive: boolean; paneCount: number } | null = null;
    if (row.session_name) {
      try {
        status = await deps.tmux.status(row.session_name);
      } catch (error) {
        console.error(
          `[watchdog] status check failed for ${row.session_name}, skipping liveness this pass: ${(error as Error).message}`,
        );
      }
      if (status && !status.alive) {
        await safeKillSession(deps.tmux, row.session_name);
        failWorkflow(deps, row.id, "tmux session disappeared", now);
        acted++;
        continue;
      }
    }

    // 2b. prompt-not-accepted — the session went ready (session.started
    // recorded) but no turn ever started within the launch window, so the
    // driven prompt never landed. `turn.started` (UserPromptSubmit) is the
    // confirmation the prompt was submitted; its absence past the window is the
    // failure. Measured from the session.started event, not updated_at (which
    // heartbeats bump).
    const startedTs = firstEventTs(deps.db, row.id, "session.started");
    if (
      startedTs !== null &&
      now - startedTs >= launchTimeout &&
      !hasEventOfType(deps.db, row.id, "turn.started")
    ) {
      if (row.session_name) await safeKillSession(deps.tmux, row.session_name);
      failWorkflow(deps, row.id, "prompt-not-accepted", now);
      acted++;
      continue;
    }

    // 3. activity freshness — skipped while a human is driving the session.
    if (row.controlled_by !== "human") {
      const transcriptMs = transcriptActivityMs(deps, row.adapter, row.transcript_path);
      // Baseline is the freshest of: hook heartbeat, transcript activity, and
      // the time the workflow entered 'running' (so a just-launched agent with
      // no heartbeat yet is not instantly idle).
      const baseline = Math.max(row.last_heartbeat ?? 0, transcriptMs ?? 0, row.updated_at);
      const age = now - baseline;
      if (age >= idleKill) {
        // Self-heal: if the agent declared itself blocked (sentinel present) it
        // is *waiting for a human*, not dead — failing/compensating here would
        // prune the worktree its resume needs and orphan the armed signal (the
        // #60 failure mode). Kill the hung session so the drive's liveness race
        // wakes and parks it (`waiting-human`), arm a resume signal, and hand
        // off — never compensate. Recorded once, not every idle tick.
        if (row.worktree_path && existsSync(sentinelPath(row.worktree_path))) {
          if (latestEventType(deps.db, row.id) !== BLOCKED_HANDOFF_EVENT) {
            if (row.session_name) await safeKillSession(deps.tmux, row.session_name);
            if (!isWaitForArmed(deps.db, row.id)) {
              armWaitForSignal(deps.db, `blocked:${row.id}`, row.id, null);
            }
            recordEvent(deps.db, {
              workflowId: row.id,
              ts: now,
              type: BLOCKED_HANDOFF_EVENT,
              payloadJson: null,
            });
            acted++;
          }
          continue;
        }
        if (row.session_name) await safeKillSession(deps.tmux, row.session_name);
        failWorkflow(deps, row.id, "idle-timeout", now);
        acted++;
        continue;
      }
      if (age >= idleThreshold && latestEventType(deps.db, row.id) !== IDLE_EVENT) {
        // Mark idle once per idle period (not every 30s tick).
        recordEvent(deps.db, { workflowId: row.id, ts: now, type: IDLE_EVENT, payloadJson: null });
        acted++;
      }
    }

    // 4. sentinel — blocked.json present but no signal armed → re-arm.
    if (row.worktree_path && existsSync(sentinelPath(row.worktree_path))) {
      if (!isWaitForArmed(deps.db, row.id)) {
        armWaitForSignal(deps.db, `blocked:${row.id}`, row.id, null);
        acted++;
      }
    }
  }
  return acted;
}

/**
 * Companion reconciler: re-read each running workflow's transcript and correct
 * heartbeat drift. If the transcript shows activity newer than `last_heartbeat`
 * (e.g. a hook POST was dropped but the agent kept working), advance the
 * heartbeat to the transcript — the transcript is the source of truth.
 */
export function reconcileTranscriptDrift(deps: WatchdogDeps): number {
  const now = (deps.now ?? Date.now)();
  let corrected = 0;
  for (const row of loadReconcilable(deps.db)) {
    if (row.state !== "running") continue;
    const transcriptMs = transcriptActivityMs(deps, row.adapter, row.transcript_path);
    if (transcriptMs !== null && transcriptMs > (row.last_heartbeat ?? 0)) {
      // last_heartbeat reflects the transcript's activity time; updated_at is
      // the wall-clock of *this* correction, so it never moves backward.
      deps.db.run("UPDATE workflows SET last_heartbeat = ?, updated_at = ? WHERE id = ?", [
        transcriptMs,
        now,
        row.id,
      ]);
      corrected++;
    }
  }
  return corrected;
}
