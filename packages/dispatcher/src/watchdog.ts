import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { TranscriptState } from "@middle/core";
import { classifyNotification, type NotificationKind } from "./notification-classify.ts";
import {
  armWaitForSignal,
  firstEventTs,
  hasEventOfType,
  isWaitForArmed,
  lastEventTs,
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
  /**
   * Capture the visible pane text — the notification failsafe's state snapshot.
   * Optional: when unwired (gate-only/test scenarios), `reconcileNotifications`
   * no-ops rather than half-acting.
   */
  capturePane?(sessionName: string): Promise<string>;
  /** Type literal text into the session — the notification failsafe's nudge. Optional (see `capturePane`). */
  sendText?(sessionName: string, text: string): Promise<void>;
  /** Press Enter — submits the `sendText` nudge. Optional (see `capturePane`). */
  sendEnter?(sessionName: string): Promise<void>;
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
  /**
   * How long after an `agent.notification` with no newer activity before the
   * notification failsafe captures the pane + nudges the agent. A grace window so
   * a transient notification the agent resolves itself isn't acted on. Default 60s.
   */
  notificationGraceMs?: number;
  /**
   * How long after the failsafe's nudge, still with no newer activity, before it
   * fast-fails the workflow (`notification-block:<kind>`). The "never hang
   * headless" backstop when the nudge doesn't take. Default 120s.
   */
  notificationKillGraceMs?: number;
  /** Engine-side rollback hook; invoked when the watchdog fails a workflow. */
  triggerCompensation?: (workflowId: string, reason: string) => void;
  /**
   * Worktree cleanup hook; invoked when the watchdog fails a `running` workflow
   * that has a `worktree_path` set. Called after the failure is recorded so
   * a cleanup error never prevents the failure decision from landing. Best-effort:
   * a stale worktree directory is disk noise, not a correctness bug.
   * In production, wired to look up the workflow's repo and call
   * `pruneWorktreeAt(repoPath, worktreePath)` (from `worktree.ts`).
   */
  pruneWorktree?: (workflowId: string, worktreePath: string) => void | Promise<void>;
  /** Override the blocked-sentinel path resolver (tests). */
  blockedSentinelPath?: (worktreePath: string) => string;
};

const DEFAULT_LAUNCH_TIMEOUT_MS = 90_000;
const DEFAULT_IDLE_THRESHOLD_MS = 5 * 60 * 1000;
const DEFAULT_IDLE_KILL_THRESHOLD_MS = 15 * 60 * 1000;
const DEFAULT_NOTIFICATION_GRACE_MS = 60 * 1000;
const DEFAULT_NOTIFICATION_KILL_GRACE_MS = 2 * 60 * 1000;
/** Pane snapshot is clipped to this many bytes on the captured event (audit, not source of truth). */
const PANE_SNAPSHOT_MAX_BYTES = 8 * 1024;

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
/**
 * Event written when the notification failsafe captures a stuck agent's state.
 * Payload: `{ kind, message, pane }` — the classification, the Notification
 * message, and the clipped pane snapshot. This is AC1's "record it on the workflow".
 */
export const NOTIFICATION_CAPTURED_EVENT = "notification.captured";
/** Event written when the failsafe nudges the agent. Payload: `{ kind }`. */
export const NOTIFICATION_INTERVENED_EVENT = "notification.intervened";

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

function failWorkflow(
  deps: WatchdogDeps,
  id: string,
  reason: string,
  now: number,
  worktreePath?: string | null,
): void {
  updateWorkflow(deps.db, id, { state: "failed" });
  recordEvent(deps.db, {
    workflowId: id,
    ts: now,
    type: FAILED_EVENT,
    payloadJson: JSON.stringify({ reason }),
  });
  deps.triggerCompensation?.(id, reason);
  // Best-effort worktree cleanup for `running` rows: a stale worktree from a
  // mid-epic daemon restart leaks disk indefinitely without this. Fire-and-forget
  // after the failure is already recorded — a cleanup error must never prevent
  // the failure decision from landing.
  if (worktreePath && deps.pruneWorktree) {
    Promise.resolve(deps.pruneWorktree(id, worktreePath)).catch((err: unknown) => {
      console.error(
        `[watchdog] pruneWorktree failed for ${worktreePath}: ${(err as Error).message}`,
      );
    });
  }
}

/**
 * Best-effort session kill. On the fail paths the kill runs *after* we've
 * already decided to fail the workflow, so a kill error must not prevent
 * recording that failure (or abort the reconciliation pass for other rows) —
 * swallow and log it. Returns whether the kill succeeded so the blocked-handoff
 * path can refuse to mark itself done (and retry next pass) if the hung session
 * is still alive.
 */
async function safeKillSession(tmux: WatchdogTmux, sessionName: string): Promise<boolean> {
  try {
    await tmux.killSession(sessionName);
    return true;
  } catch (error) {
    console.error(`[watchdog] killSession failed for ${sessionName}: ${(error as Error).message}`);
    return false;
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
        failWorkflow(deps, row.id, "tmux session disappeared", now, row.worktree_path);
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
      failWorkflow(deps, row.id, "prompt-not-accepted", now, row.worktree_path);
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
            // The kill is what wakes the drive's liveness race to park. If it
            // fails, do NOT record the handoff — otherwise the next pass's
            // `latestEventType` guard suppresses the retry and the session never
            // dies, leaving the workflow stuck `running`. Retry next tick instead.
            const killed = row.session_name
              ? await safeKillSession(deps.tmux, row.session_name)
              : true;
            if (killed) {
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
          }
          continue;
        }
        if (row.session_name) await safeKillSession(deps.tmux, row.session_name);
        failWorkflow(deps, row.id, "idle-timeout", now, row.worktree_path);
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

/** Clip pane text to a byte bound for the audit event; mark it so a reader knows. */
function clipPane(pane: string): string {
  if (Buffer.byteLength(pane, "utf8") <= PANE_SNAPSHOT_MAX_BYTES) return pane;
  const clipped = Buffer.from(pane, "utf8").subarray(0, PANE_SNAPSHOT_MAX_BYTES).toString("utf8");
  return `${clipped}…[truncated]`;
}

/** Parse the most recent `events` row of a type, returning its payload object (or null). */
function latestEventPayload(
  db: Database,
  workflowId: string,
  type: string,
): Record<string, unknown> | null {
  // `id DESC` breaks a `ts` tie deterministically (the failsafe can write events
  // sharing a ts in one tick). Today `idx_events_workflow_ts` happens to return
  // the highest id first within a ts group, but that's a query-plan accident — the
  // explicit tie-breaker pins "latest row wins" independent of the index/plan.
  const row = db
    .query(
      "SELECT payload_json FROM events WHERE workflow_id = ? AND type = ? ORDER BY ts DESC, id DESC LIMIT 1",
    )
    .get(workflowId, type) as { payload_json: string | null } | null;
  if (!row?.payload_json) return null;
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // A truncated/garbled payload is an audit record, not a contract — treat as empty.
    return null;
  }
}

/** The `message` of the latest `agent.notification` event, or "" if absent/unparseable. */
function latestNotificationMessage(db: Database, workflowId: string): string {
  const payload = latestEventPayload(db, workflowId, "agent.notification");
  return typeof payload?.message === "string" ? payload.message : "";
}

/** The recorded `kind` of the latest `notification.captured` event, defaulting to idle-unknown. */
function latestNotificationKind(db: Database, workflowId: string): NotificationKind {
  const kind = latestEventPayload(db, workflowId, NOTIFICATION_CAPTURED_EVENT)?.kind;
  return kind === "permission" || kind === "input" ? kind : "idle-unknown";
}

/**
 * The instruction the failsafe types into a stuck session. Tells the agent it's
 * headless (no human will answer) and gives it the two legitimate exits: continue
 * the task, or write `.middle/blocked.json` and stop — which routes a genuine
 * block into the existing asked-question park. A permission/env-repair block gets
 * an extra line steering it off that (the #129 off-task-repair failure mode).
 */
function buildNotificationNudge(kind: NotificationKind): string {
  const head =
    "[middle] You appear to be waiting for human input, but you are running headless under middle — no human will respond.";
  const repair =
    kind === "permission"
      ? " Do not wait for permission and do not try to repair your environment (chmod, settings.json, hooks)."
      : "";
  const tail =
    'If you can continue your task, do so now. If you genuinely cannot proceed without a human decision, write .middle/blocked.json (with a "question" and "context") and then stop.';
  return `${head}${repair} ${tail}`;
}

/** Capture the pane, swallowing a tmux error (a dead/unreadable pane → empty snapshot). */
async function safeCapturePane(tmux: WatchdogTmux, sessionName: string): Promise<string> {
  try {
    return (await tmux.capturePane!(sessionName)).trim();
  } catch (error) {
    console.error(`[watchdog] capturePane failed for ${sessionName}: ${(error as Error).message}`);
    return "";
  }
}

/** Type + submit the nudge; returns whether it landed (a tmux error → false, logged). */
async function safeNudge(tmux: WatchdogTmux, sessionName: string, text: string): Promise<boolean> {
  try {
    await tmux.sendText!(sessionName, text);
    await tmux.sendEnter!(sessionName);
    return true;
  } catch (error) {
    console.error(`[watchdog] nudge failed for ${sessionName}: ${(error as Error).message}`);
    return false;
  }
}

/**
 * The notification failsafe (#128): rescue a headless agent stuck on a Claude
 * `Notification` before it burns to the 15-min idle-kill ceiling. A peer of
 * `runWatchdog` — same staleness discipline, same `launching`/`running` sweep,
 * so it covers **every** spawn kind (implementation, recommender, documentation).
 * Run it before `runWatchdog` so a notification-block is handled faster (and more
 * informatively) than the generic idle-timeout would.
 *
 * Per running, middle-driven session with a live pane:
 *
 *   1. **Detect** — the latest event is `agent.notification` and nothing has been
 *      active since (no transcript/heartbeat newer than it). A grace window
 *      (`notificationGraceMs`) lets a transient notification the agent clears
 *      itself pass untouched.
 *   2. **Capture + classify + intervene** (once per notification) — snapshot the
 *      pane (`notification.captured`), classify it, and nudge the agent to
 *      proceed-or-block (`notification.intervened`). The nudge is the same
 *      `sendText`+`sendEnter` mechanism the bare-stop nudge uses — no synthetic
 *      dialog-approval keystrokes.
 *   3. **Fast-fail** — if the agent is *still* idle `notificationKillGraceMs`
 *      after the nudge, fail the workflow (`notification-block:<kind>`) via the
 *      proven idle-kill terminus, with the captured context on the row. This is
 *      the "never hang headless" guarantee.
 *
 * Skipped while `controlled_by = 'human'` (a human will answer the notification)
 * and a no-op when the tmux surface lacks `capturePane`/`sendText`/`sendEnter`.
 * State is derived from event rows (no per-row columns): a stall is "handled"
 * once a `notification.captured` row is newer than the last real activity, so a
 * stuck agent re-emitting the same notification can't reset the kill clock — only
 * genuine activity, then a fresh stall, re-arms capture.
 */
export async function reconcileNotifications(deps: WatchdogDeps): Promise<number> {
  const tmux = deps.tmux;
  if (!tmux.capturePane || !tmux.sendText || !tmux.sendEnter) return 0;
  const now = (deps.now ?? Date.now)();
  const grace = deps.notificationGraceMs ?? DEFAULT_NOTIFICATION_GRACE_MS;
  const killGrace = deps.notificationKillGraceMs ?? DEFAULT_NOTIFICATION_KILL_GRACE_MS;

  let acted = 0;
  for (const row of loadReconcilable(deps.db)) {
    // Only a live, middle-driven, running session can be stuck on a notification.
    if (row.state !== "running" || !row.session_name || row.controlled_by === "human") continue;

    const notifTs = lastEventTs(deps.db, row.id, "agent.notification");
    if (notifTs === null) continue;

    // Anchor on real agent activity: heartbeat (tool.pre/post, and drift-corrected
    // from the transcript) and the transcript itself. NOT `updated_at` — drift
    // bookkeeping bumps that to wall-clock `now`, which would mask a genuine
    // notification-idle. A notification bumps neither, so a quiet agent's activity
    // stays older than the notification; one that resumed reads newer.
    const transcriptMs = transcriptActivityMs(deps, row.adapter, row.transcript_path);
    const activityMs = Math.max(row.last_heartbeat ?? 0, transcriptMs ?? 0);
    // No notification since the agent was last active → not stuck on one.
    if (notifTs <= activityMs) continue;

    // "Handled this streak" is anchored on activity, not on `notifTs`: a stuck
    // agent that keeps re-emitting the *same* "waiting" notification must NOT
    // re-arm capture each time (that would reset the kill clock forever and the
    // run would never fast-fail). Only real activity since the capture (a genuine
    // resume, then a fresh stall) re-arms it.
    const capturedTs = lastEventTs(deps.db, row.id, NOTIFICATION_CAPTURED_EVENT);
    const handled = capturedTs !== null && capturedTs > activityMs;

    if (!handled) {
      if (now - notifTs < grace) continue; // within the grace window — let it settle.
      const pane = await safeCapturePane(tmux, row.session_name);
      const message = latestNotificationMessage(deps.db, row.id);
      const kind = classifyNotification({ message, pane });
      recordEvent(deps.db, {
        workflowId: row.id,
        ts: now,
        type: NOTIFICATION_CAPTURED_EVENT,
        payloadJson: JSON.stringify({ kind, message, pane: clipPane(pane) }),
      });
      if (await safeNudge(tmux, row.session_name, buildNotificationNudge(kind))) {
        recordEvent(deps.db, {
          workflowId: row.id,
          ts: now,
          type: NOTIFICATION_INTERVENED_EVENT,
          payloadJson: JSON.stringify({ kind }),
        });
      }
      acted++;
      continue;
    }

    // Captured + nudged this stall, and still idle: if the nudge hasn't taken
    // within the kill-grace, fast-fail with the captured classification. Anchored
    // on the intervention ts, so repeat notifications don't push the deadline out.
    const intervenedTs = lastEventTs(deps.db, row.id, NOTIFICATION_INTERVENED_EVENT);
    if (now - (intervenedTs ?? capturedTs!) >= killGrace) {
      await safeKillSession(tmux, row.session_name);
      failWorkflow(
        deps,
        row.id,
        `notification-block:${latestNotificationKind(deps.db, row.id)}`,
        now,
        row.worktree_path,
      );
      acted++;
    }
  }
  return acted;
}
