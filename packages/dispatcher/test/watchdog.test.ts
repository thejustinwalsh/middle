import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptState } from "@middle/core";
import { openAndMigrate } from "../src/db.ts";
import { createWorkflowRecord, getWorkflow, recordEvent } from "../src/workflow-record.ts";
import {
  BLOCKED_HANDOFF_EVENT,
  FAILED_EVENT,
  IDLE_EVENT,
  NOTIFICATION_CAPTURED_EVENT,
  NOTIFICATION_INTERVENED_EVENT,
  reconcileNotifications,
  reconcileTranscriptDrift,
  runWatchdog,
  type WatchdogDeps,
  type WatchdogTmux,
} from "../src/watchdog.ts";

const NOW = 10_000_000;
const MIN = 60_000;

let scratch: string;
let db: Database;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "middle-wd-"));
  db = openAndMigrate(join(scratch, "db.sqlite3"));
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

type SeedOpts = {
  state: string;
  sessionName?: string | null;
  worktreePath?: string | null;
  transcriptPath?: string | null;
  lastHeartbeat?: number | null;
  updatedAt?: number;
  controlledBy?: "middle" | "human";
};

function seed(opts: SeedOpts): string {
  const id = crypto.randomUUID();
  createWorkflowRecord(db, {
    id,
    kind: "implementation",
    repo: "thejustinwalsh/middle",
    epicNumber: 14,
    adapter: "claude",
  });
  db.run(
    `UPDATE workflows SET state = ?, session_name = ?, worktree_path = ?, transcript_path = ?,
        last_heartbeat = ?, updated_at = ?, controlled_by = ? WHERE id = ?`,
    [
      opts.state,
      opts.sessionName ?? null,
      opts.worktreePath ?? null,
      opts.transcriptPath ?? null,
      opts.lastHeartbeat ?? null,
      opts.updatedAt ?? NOW,
      opts.controlledBy ?? "middle",
      id,
    ],
  );
  return id;
}

function eventTypes(workflowId: string): string[] {
  return (
    db.query("SELECT type FROM events WHERE workflow_id = ? ORDER BY id").all(workflowId) as Array<{
      type: string;
    }>
  ).map((r) => r.type);
}

function failureReason(workflowId: string): string | undefined {
  const row = db
    .query(
      "SELECT payload_json FROM events WHERE workflow_id = ? AND type = ? ORDER BY id DESC LIMIT 1",
    )
    .get(workflowId, FAILED_EVENT) as { payload_json: string | null } | null;
  return row?.payload_json
    ? (JSON.parse(row.payload_json) as { reason: string }).reason
    : undefined;
}

/** A tmux stub: configurable liveness, records every killSession. */
function makeTmux(alive: boolean) {
  const killed: string[] = [];
  return {
    killed,
    ops: {
      status: async () => ({ alive, paneCount: alive ? 1 : 0 }),
      killSession: async (name: string) => {
        killed.push(name);
      },
    },
  };
}

/** A transcript reader stub returning a fixed lastActivity (or throwing). */
function makeAdapter(lastActivityMs: number | null) {
  return () => ({
    readTranscriptState: (): TranscriptState => {
      if (lastActivityMs === null) throw new Error("no transcript");
      return {
        lastActivity: new Date(lastActivityMs).toISOString(),
        contextTokens: 0,
        turnCount: 0,
        lastToolUse: null,
      };
    },
  });
}

function baseDeps(over: Partial<WatchdogDeps>): WatchdogDeps {
  return {
    db,
    tmux: makeTmux(true).ops,
    getAdapter: makeAdapter(null),
    now: () => NOW,
    launchTimeoutMs: 90_000,
    idleThresholdMs: 5 * MIN,
    idleKillThresholdMs: 15 * MIN,
    ...over,
  };
}

describe("watchdog — launch timeout", () => {
  test("a launching workflow past the window is failed 'stuck-launching'", async () => {
    const id = seed({ state: "launching", updatedAt: NOW - 2 * 90_000 });
    await runWatchdog(baseDeps({}));
    expect(getWorkflow(db, id)!.state).toBe("failed");
    expect(failureReason(id)).toBe("stuck-launching");
  });

  test("a launching workflow within the window is left alone", async () => {
    const id = seed({ state: "launching", updatedAt: NOW - 10_000 });
    await runWatchdog(baseDeps({}));
    expect(getWorkflow(db, id)!.state).toBe("launching");
  });
});

describe("watchdog — prompt not accepted", () => {
  test("a running session that went ready but never started a turn is failed 'prompt-not-accepted'", async () => {
    const id = seed({ state: "running", sessionName: "middle-14", updatedAt: NOW });
    recordEvent(db, {
      workflowId: id,
      ts: NOW - 2 * 90_000,
      type: "session.started",
      payloadJson: null,
    });
    const tmux = makeTmux(true);
    await runWatchdog(baseDeps({ tmux: tmux.ops }));
    expect(getWorkflow(db, id)!.state).toBe("failed");
    expect(failureReason(id)).toBe("prompt-not-accepted");
    expect(tmux.killed).toContain("middle-14");
  });

  test("a running session whose prompt landed (turn.started present) is not failed", async () => {
    const id = seed({ state: "running", sessionName: "middle-14", updatedAt: NOW });
    recordEvent(db, {
      workflowId: id,
      ts: NOW - 2 * 90_000,
      type: "session.started",
      payloadJson: null,
    });
    recordEvent(db, {
      workflowId: id,
      ts: NOW - 2 * 90_000 + 1,
      type: "turn.started",
      payloadJson: null,
    });
    await runWatchdog(baseDeps({ tmux: makeTmux(true).ops }));
    expect(getWorkflow(db, id)!.state).toBe("running");
  });

  test("a running session still within the launch window is not yet failed", async () => {
    const id = seed({ state: "running", sessionName: "middle-14", updatedAt: NOW });
    recordEvent(db, {
      workflowId: id,
      ts: NOW - 10_000,
      type: "session.started",
      payloadJson: null,
    });
    await runWatchdog(baseDeps({ tmux: makeTmux(true).ops }));
    expect(getWorkflow(db, id)!.state).toBe("running");
  });
});

describe("watchdog — tmux liveness", () => {
  test("a running workflow with a dead session is failed + compensation triggered", async () => {
    const id = seed({ state: "running", sessionName: "middle-14", updatedAt: NOW });
    const tmux = makeTmux(false);
    const compensated: string[] = [];
    await runWatchdog(
      baseDeps({ tmux: tmux.ops, triggerCompensation: (wid) => compensated.push(wid) }),
    );
    expect(getWorkflow(db, id)!.state).toBe("failed");
    expect(failureReason(id)).toBe("tmux session disappeared");
    expect(tmux.killed).toContain("middle-14");
    expect(compensated).toEqual([id]);
  });

  test("a running workflow with a live session is not failed for liveness", async () => {
    const id = seed({ state: "running", sessionName: "middle-14", updatedAt: NOW });
    await runWatchdog(baseDeps({ tmux: makeTmux(true).ops }));
    expect(getWorkflow(db, id)!.state).toBe("running");
  });

  test("a status() error is inconclusive — liveness is skipped, fresh row not failed", async () => {
    const id = seed({ state: "running", sessionName: "middle-14", updatedAt: NOW });
    const tmux = {
      status: async () => {
        throw new Error("tmux server not running");
      },
      killSession: async () => {},
    };
    await runWatchdog(baseDeps({ tmux }));
    // inconclusive status must not fail a fresh workflow on liveness grounds
    expect(getWorkflow(db, id)!.state).toBe("running");
  });

  test("a persistent status() error does NOT block rule 3 — a stale row still idle-times-out", async () => {
    const id = seed({
      state: "running",
      sessionName: "middle-14",
      lastHeartbeat: NOW - 20 * MIN,
      updatedAt: NOW - 20 * MIN,
    });
    const tmux = {
      status: async () => {
        throw new Error("tmux server not running");
      },
      killSession: async () => {},
    };
    await runWatchdog(baseDeps({ tmux }));
    // liveness is inconclusive, but the wall-clock backstop must still fire so
    // a row whose status() keeps erroring can't stay 'running' forever
    expect(getWorkflow(db, id)!.state).toBe("failed");
    expect(failureReason(id)).toBe("idle-timeout");
  });

  test("a status() error on one row does not abort reconciliation of others", async () => {
    const bad = seed({ state: "running", sessionName: "middle-bad", updatedAt: NOW });
    const stuck = seed({ state: "launching", updatedAt: NOW - 2 * 90_000 });
    const tmux = {
      status: async (name: string) => {
        if (name === "middle-bad") throw new Error("tmux error");
        return { alive: true, paneCount: 1 };
      },
      killSession: async () => {},
    };
    await runWatchdog(baseDeps({ tmux }));
    // the launch-timeout row is still reconciled despite the earlier tmux error
    expect(getWorkflow(db, bad)!.state).toBe("running");
    expect(getWorkflow(db, stuck)!.state).toBe("failed");
    expect(failureReason(stuck)).toBe("stuck-launching");
  });

  test("a killSession() error still records the failure decision", async () => {
    const id = seed({ state: "running", sessionName: "middle-14", updatedAt: NOW });
    const tmux = {
      status: async () => ({ alive: false, paneCount: 0 }),
      killSession: async () => {
        throw new Error("kill failed");
      },
    };
    await runWatchdog(baseDeps({ tmux }));
    // kill is best-effort; the failure decision must still be persisted
    expect(getWorkflow(db, id)!.state).toBe("failed");
    expect(failureReason(id)).toBe("tmux session disappeared");
  });
});

describe("watchdog — activity freshness", () => {
  test("idle ≥ threshold marks one idle event but does not kill", async () => {
    const id = seed({
      state: "running",
      sessionName: "middle-14",
      lastHeartbeat: NOW - 10 * MIN,
      updatedAt: NOW - 10 * MIN,
    });
    const tmux = makeTmux(true);
    await runWatchdog(baseDeps({ tmux: tmux.ops }));
    expect(eventTypes(id)).toEqual([IDLE_EVENT]);
    expect(getWorkflow(db, id)!.state).toBe("running");
    // a second pass while still idle does not pile up duplicate idle events
    await runWatchdog(baseDeps({ tmux: tmux.ops }));
    expect(eventTypes(id)).toEqual([IDLE_EVENT]);
    expect(tmux.killed).toHaveLength(0);
  });

  test("idle ≥ kill-threshold kills the session and fails 'idle-timeout'", async () => {
    const id = seed({
      state: "running",
      sessionName: "middle-14",
      lastHeartbeat: NOW - 20 * MIN,
      updatedAt: NOW - 20 * MIN,
    });
    const tmux = makeTmux(true);
    await runWatchdog(baseDeps({ tmux: tmux.ops }));
    expect(getWorkflow(db, id)!.state).toBe("failed");
    expect(failureReason(id)).toBe("idle-timeout");
    expect(tmux.killed).toContain("middle-14");
  });

  test("freshness is skipped while controlled_by = 'human'", async () => {
    const id = seed({
      state: "running",
      sessionName: "middle-14",
      lastHeartbeat: NOW - 20 * MIN,
      updatedAt: NOW - 20 * MIN,
      controlledBy: "human",
    });
    const tmux = makeTmux(true);
    await runWatchdog(baseDeps({ tmux: tmux.ops }));
    expect(getWorkflow(db, id)!.state).toBe("running");
    expect(eventTypes(id)).toHaveLength(0);
    expect(tmux.killed).toHaveLength(0);
  });

  test("a stale heartbeat is rescued by fresh transcript activity (cross-check)", async () => {
    const id = seed({
      state: "running",
      sessionName: "middle-14",
      transcriptPath: "/t/x.jsonl",
      lastHeartbeat: NOW - 20 * MIN, // hooks look dead
      updatedAt: NOW - 20 * MIN,
    });
    // but the transcript shows activity 1 minute ago → not idle
    await runWatchdog(baseDeps({ getAdapter: makeAdapter(NOW - 1 * MIN) }));
    expect(getWorkflow(db, id)!.state).toBe("running");
    expect(eventTypes(id)).toHaveLength(0);
  });
});

describe("watchdog — sentinel re-arm", () => {
  test("a blocked.json with no armed signal arms one, idempotently", async () => {
    const blocked = join(scratch, "blocked.json");
    writeFileSync(blocked, JSON.stringify({ reason: "which window?" }));
    const id = seed({ state: "running", sessionName: "middle-14", worktreePath: scratch });
    const deps = baseDeps({ blockedSentinelPath: () => blocked });

    await runWatchdog(deps);
    const armed = () =>
      db.query("SELECT count(*) AS n FROM waitfor_signals WHERE workflow_id = ?").get(id) as {
        n: number;
      };
    expect(armed().n).toBe(1);
    // re-running does not arm a duplicate
    await runWatchdog(deps);
    expect(armed().n).toBe(1);
  });

  test("no sentinel file → no signal armed", async () => {
    const id = seed({ state: "running", sessionName: "middle-14", worktreePath: scratch });
    await runWatchdog(baseDeps({ blockedSentinelPath: () => join(scratch, "absent.json") }));
    const n = (
      db.query("SELECT count(*) AS n FROM waitfor_signals WHERE workflow_id = ?").get(id) as {
        n: number;
      }
    ).n;
    expect(n).toBe(0);
  });
});

describe("watchdog — blocked sentinel self-heal", () => {
  test("idle ≥ kill-threshold with a blocked sentinel hands off to the drive, not compensation", async () => {
    const blocked = join(scratch, "blocked.json");
    writeFileSync(blocked, JSON.stringify({ question: "is the sandbox configured?" }));
    const id = seed({
      state: "running",
      sessionName: "middle-14",
      worktreePath: scratch,
      lastHeartbeat: NOW - 20 * MIN,
      updatedAt: NOW - 20 * MIN,
    });
    const tmux = makeTmux(true);
    const compensated: string[] = [];
    await runWatchdog(
      baseDeps({
        tmux: tmux.ops,
        blockedSentinelPath: () => blocked,
        triggerCompensation: (wid) => compensated.push(wid),
      }),
    );
    // self-heal: the agent declared itself blocked, so the watchdog must NOT
    // fail/compensate (which would prune the worktree the resume needs).
    expect(getWorkflow(db, id)!.state).toBe("running");
    expect(failureReason(id)).toBeUndefined();
    expect(compensated).toEqual([]);
    // the hung session IS killed so the drive's liveness race wakes and parks it
    expect(tmux.killed).toContain("middle-14");
    // a resume signal is armed so the poller can resume on the human's reply
    const armed = db
      .query("SELECT count(*) AS n FROM waitfor_signals WHERE workflow_id = ?")
      .get(id) as { n: number };
    expect(armed.n).toBe(1);
    expect(eventTypes(id)).toContain(BLOCKED_HANDOFF_EVENT);
  });

  test("a failed kill does not record the handoff — it retries next pass", async () => {
    const blocked = join(scratch, "blocked.json");
    writeFileSync(blocked, JSON.stringify({ question: "which window?" }));
    const id = seed({
      state: "running",
      sessionName: "middle-14",
      worktreePath: scratch,
      lastHeartbeat: NOW - 20 * MIN,
      updatedAt: NOW - 20 * MIN,
    });
    const tmux = {
      status: async () => ({ alive: true, paneCount: 1 }),
      killSession: async () => {
        throw new Error("kill failed");
      },
    };
    await runWatchdog(baseDeps({ tmux, blockedSentinelPath: () => blocked }));
    // The kill is what wakes the drive to park; if it failed, recording the
    // handoff would suppress the retry and strand the workflow in 'running'.
    expect(eventTypes(id)).not.toContain(BLOCKED_HANDOFF_EVENT);
    expect(getWorkflow(db, id)!.state).toBe("running");
    const armed = db
      .query("SELECT count(*) AS n FROM waitfor_signals WHERE workflow_id = ?")
      .get(id) as { n: number };
    expect(armed.n).toBe(0);
  });

  test("the handoff is recorded once, not every idle tick", async () => {
    const blocked = join(scratch, "blocked.json");
    writeFileSync(blocked, JSON.stringify({ question: "which window?" }));
    const id = seed({
      state: "running",
      sessionName: "middle-14",
      worktreePath: scratch,
      lastHeartbeat: NOW - 20 * MIN,
      updatedAt: NOW - 20 * MIN,
    });
    const deps = baseDeps({ blockedSentinelPath: () => blocked });
    await runWatchdog(deps);
    await runWatchdog(deps);
    expect(eventTypes(id).filter((t) => t === BLOCKED_HANDOFF_EVENT)).toHaveLength(1);
  });
});

describe("reconcileTranscriptDrift", () => {
  test("advances last_heartbeat when the transcript is newer than the recorded beat", () => {
    const id = seed({
      state: "running",
      transcriptPath: "/t/x.jsonl",
      lastHeartbeat: NOW - 10 * MIN,
      updatedAt: NOW - 10 * MIN,
    });
    const corrected = reconcileTranscriptDrift(
      baseDeps({ getAdapter: makeAdapter(NOW - 1 * MIN) }),
    );
    expect(corrected).toBe(1);
    const row = db.query("SELECT last_heartbeat FROM workflows WHERE id = ?").get(id) as {
      last_heartbeat: number;
    };
    expect(row.last_heartbeat).toBe(NOW - 1 * MIN);
  });

  test("leaves the heartbeat alone when the transcript is older", () => {
    const id = seed({
      state: "running",
      transcriptPath: "/t/x.jsonl",
      lastHeartbeat: NOW - 1 * MIN,
      updatedAt: NOW - 1 * MIN,
    });
    const corrected = reconcileTranscriptDrift(
      baseDeps({ getAdapter: makeAdapter(NOW - 10 * MIN) }),
    );
    expect(corrected).toBe(0);
    const row = db.query("SELECT last_heartbeat FROM workflows WHERE id = ?").get(id) as {
      last_heartbeat: number;
    };
    expect(row.last_heartbeat).toBe(NOW - 1 * MIN);
  });
});

/** A tmux stub with the notification-failsafe surface; records pane reads, nudges, kills. */
function makeNotifTmux(opts?: { pane?: string; alive?: boolean }) {
  const killed: string[] = [];
  const sent: Array<{ session: string; text: string }> = [];
  const entered: string[] = [];
  const ops: WatchdogTmux = {
    status: async () => ({ alive: opts?.alive ?? true, paneCount: 1 }),
    killSession: async (name: string) => {
      killed.push(name);
    },
    capturePane: async () => opts?.pane ?? "",
    sendText: async (session: string, text: string) => {
      sent.push({ session, text });
    },
    sendEnter: async (session: string) => {
      entered.push(session);
    },
  };
  return { killed, sent, entered, ops };
}

/** Record an `agent.notification` event with an optional `message` payload. */
function seedNotification(id: string, ts: number, message?: string): void {
  recordEvent(db, {
    workflowId: id,
    ts,
    type: "agent.notification",
    payloadJson: message === undefined ? null : JSON.stringify({ message }),
  });
}

function capturedPayload(id: string): { kind?: string; message?: string; pane?: string } | null {
  const row = db
    .query(
      "SELECT payload_json FROM events WHERE workflow_id = ? AND type = ? ORDER BY ts DESC LIMIT 1",
    )
    .get(id, NOTIFICATION_CAPTURED_EVENT) as { payload_json: string | null } | null;
  return row?.payload_json ? JSON.parse(row.payload_json) : null;
}

describe("notification failsafe — detect + capture + intervene", () => {
  test("a notification still within the grace window is left alone", async () => {
    const id = seed({
      state: "running",
      sessionName: "middle-14",
      lastHeartbeat: NOW - 5 * MIN,
      updatedAt: NOW - 5 * MIN,
    });
    seedNotification(id, NOW - 30_000, "Claude is waiting for your input"); // < 60s grace
    const tmux = makeNotifTmux();
    const acted = await reconcileNotifications(baseDeps({ tmux: tmux.ops }));
    expect(acted).toBe(0);
    expect(eventTypes(id)).toEqual(["agent.notification"]);
    expect(tmux.sent).toHaveLength(0);
  });

  test("a notification past the grace window captures the pane, classifies, and nudges", async () => {
    const id = seed({
      state: "running",
      sessionName: "middle-14",
      lastHeartbeat: NOW - 5 * MIN,
      updatedAt: NOW - 5 * MIN,
    });
    seedNotification(id, NOW - 2 * MIN, "Claude needs your permission to use Bash");
    const tmux = makeNotifTmux({ pane: "tool: Bash\nDo you want to proceed?" });
    const acted = await reconcileNotifications(baseDeps({ tmux: tmux.ops }));
    expect(acted).toBe(1);
    expect(eventTypes(id)).toEqual([
      "agent.notification",
      NOTIFICATION_CAPTURED_EVENT,
      NOTIFICATION_INTERVENED_EVENT,
    ]);
    const payload = capturedPayload(id);
    expect(payload?.kind).toBe("permission");
    expect(payload?.message).toBe("Claude needs your permission to use Bash");
    expect(payload?.pane).toContain("Do you want to proceed?");
    // The nudge was typed + submitted into the right session.
    expect(tmux.sent).toEqual([{ session: "middle-14", text: expect.any(String) }]);
    expect(tmux.sent[0]!.text).toContain("headless");
    expect(tmux.sent[0]!.text).toContain(".middle/blocked.json");
    expect(tmux.entered).toEqual(["middle-14"]);
    // No kill yet — the agent gets the kill-grace to act on the nudge.
    expect(tmux.killed).toHaveLength(0);
    expect(getWorkflow(db, id)!.state).toBe("running");
  });

  test("classifies a plain 'waiting for input' notification as a question (kind=input)", async () => {
    const id = seed({
      state: "running",
      sessionName: "middle-14",
      lastHeartbeat: NOW - 5 * MIN,
      updatedAt: NOW - 5 * MIN,
    });
    seedNotification(id, NOW - 2 * MIN, "Claude is waiting for your input");
    await reconcileNotifications(baseDeps({ tmux: makeNotifTmux({ pane: "idle" }).ops }));
    expect(capturedPayload(id)?.kind).toBe("input");
  });

  test("an agent that resumed after the notification (newer activity) is left alone", async () => {
    const id = seed({
      state: "running",
      sessionName: "middle-14",
      lastHeartbeat: NOW - 30_000, // newer than the notification → working again
      updatedAt: NOW - 5 * MIN,
    });
    seedNotification(id, NOW - 2 * MIN, "Claude is waiting for your input");
    const tmux = makeNotifTmux();
    const acted = await reconcileNotifications(baseDeps({ tmux: tmux.ops }));
    expect(acted).toBe(0);
    expect(tmux.sent).toHaveLength(0);
  });

  test("a human-controlled session is never rescued (a human will answer)", async () => {
    const id = seed({
      state: "running",
      sessionName: "middle-14",
      lastHeartbeat: NOW - 5 * MIN,
      updatedAt: NOW - 5 * MIN,
      controlledBy: "human",
    });
    seedNotification(id, NOW - 2 * MIN, "Claude is waiting for your input");
    const acted = await reconcileNotifications(baseDeps({ tmux: makeNotifTmux().ops }));
    expect(acted).toBe(0);
    expect(getWorkflow(db, id)!.state).toBe("running");
  });

  test("no-op when the tmux surface lacks the failsafe methods", async () => {
    const id = seed({
      state: "running",
      sessionName: "middle-14",
      lastHeartbeat: NOW - 5 * MIN,
      updatedAt: NOW - 5 * MIN,
    });
    seedNotification(id, NOW - 2 * MIN, "Claude is waiting for your input");
    // baseDeps' default tmux has only status + killSession.
    const acted = await reconcileNotifications(baseDeps({}));
    expect(acted).toBe(0);
    expect(eventTypes(id)).toEqual(["agent.notification"]);
  });

  test("a capture-only notification (no message payload) still classifies + nudges", async () => {
    const id = seed({
      state: "running",
      sessionName: "middle-14",
      lastHeartbeat: NOW - 5 * MIN,
      updatedAt: NOW - 5 * MIN,
    });
    seedNotification(id, NOW - 2 * MIN); // null payload
    await reconcileNotifications(baseDeps({ tmux: makeNotifTmux({ pane: "❯ 1. Yes" }).ops }));
    // empty message but the pane shows a dialog → permission
    expect(capturedPayload(id)?.kind).toBe("permission");
  });
});

describe("notification failsafe — fast-fail backstop", () => {
  /** Seed a row already captured + nudged for its notification, still idle. */
  function seedHandled(opts: { kind: string; intervenedAt: number; notifAt: number }): string {
    const id = seed({
      state: "running",
      sessionName: "middle-14",
      lastHeartbeat: NOW - 10 * MIN,
      updatedAt: NOW - 10 * MIN,
    });
    seedNotification(id, opts.notifAt, "Claude is waiting for your input");
    recordEvent(db, {
      workflowId: id,
      ts: opts.intervenedAt,
      type: NOTIFICATION_CAPTURED_EVENT,
      payloadJson: JSON.stringify({ kind: opts.kind, message: "", pane: "" }),
    });
    recordEvent(db, {
      workflowId: id,
      ts: opts.intervenedAt,
      type: NOTIFICATION_INTERVENED_EVENT,
      payloadJson: JSON.stringify({ kind: opts.kind }),
    });
    return id;
  }

  test("still idle past the kill-grace → fast-fails with the captured kind and kills the session", async () => {
    const id = seedHandled({
      kind: "permission",
      notifAt: NOW - 5 * MIN,
      intervenedAt: NOW - 3 * MIN,
    });
    const tmux = makeNotifTmux();
    const compensated: string[] = [];
    const acted = await reconcileNotifications(
      baseDeps({ tmux: tmux.ops, triggerCompensation: (wid) => compensated.push(wid) }),
    );
    expect(acted).toBe(1);
    expect(getWorkflow(db, id)!.state).toBe("failed");
    expect(failureReason(id)).toBe("notification-block:permission");
    expect(tmux.killed).toContain("middle-14");
    expect(compensated).toEqual([id]);
  });

  test("within the kill-grace → not yet failed (the nudge still has time to take)", async () => {
    const id = seedHandled({ kind: "input", notifAt: NOW - 90_000, intervenedAt: NOW - 30_000 });
    const tmux = makeNotifTmux();
    const acted = await reconcileNotifications(baseDeps({ tmux: tmux.ops }));
    expect(acted).toBe(0);
    expect(getWorkflow(db, id)!.state).toBe("running");
    expect(tmux.killed).toHaveLength(0);
  });

  test("a fresh notification after a handled one re-arms the failsafe (re-captures)", async () => {
    // captured/intervened are OLD relative to a NEW notification → handled=false again.
    const id = seedHandled({ kind: "input", notifAt: NOW - 10 * MIN, intervenedAt: NOW - 9 * MIN });
    seedNotification(id, NOW - 2 * MIN, "Claude needs your permission to use Bash");
    const tmux = makeNotifTmux({ pane: "idle" });
    const acted = await reconcileNotifications(baseDeps({ tmux: tmux.ops }));
    expect(acted).toBe(1);
    // re-captured for the new notification rather than escalating on the stale one
    expect(getWorkflow(db, id)!.state).toBe("running");
    expect(capturedPayload(id)?.kind).toBe("permission");
    expect(tmux.sent).toHaveLength(1);
  });
});
