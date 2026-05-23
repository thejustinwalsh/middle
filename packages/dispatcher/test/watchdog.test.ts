import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptState } from "@middle/core";
import { openAndMigrate } from "../src/db.ts";
import { createWorkflowRecord, getWorkflow, recordEvent } from "../src/workflow-record.ts";
import {
  FAILED_EVENT,
  IDLE_EVENT,
  reconcileTranscriptDrift,
  runWatchdog,
  type WatchdogDeps,
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
    .query("SELECT payload_json FROM events WHERE workflow_id = ? AND type = ? ORDER BY id DESC LIMIT 1")
    .get(workflowId, FAILED_EVENT) as { payload_json: string | null } | null;
  return row?.payload_json ? (JSON.parse(row.payload_json) as { reason: string }).reason : undefined;
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
    recordEvent(db, { workflowId: id, ts: NOW - 2 * 90_000, type: "session.started", payloadJson: null });
    const tmux = makeTmux(true);
    await runWatchdog(baseDeps({ tmux: tmux.ops }));
    expect(getWorkflow(db, id)!.state).toBe("failed");
    expect(failureReason(id)).toBe("prompt-not-accepted");
    expect(tmux.killed).toContain("middle-14");
  });

  test("a running session whose prompt landed (turn.started present) is not failed", async () => {
    const id = seed({ state: "running", sessionName: "middle-14", updatedAt: NOW });
    recordEvent(db, { workflowId: id, ts: NOW - 2 * 90_000, type: "session.started", payloadJson: null });
    recordEvent(db, { workflowId: id, ts: NOW - 2 * 90_000 + 1, type: "turn.started", payloadJson: null });
    await runWatchdog(baseDeps({ tmux: makeTmux(true).ops }));
    expect(getWorkflow(db, id)!.state).toBe("running");
  });

  test("a running session still within the launch window is not yet failed", async () => {
    const id = seed({ state: "running", sessionName: "middle-14", updatedAt: NOW });
    recordEvent(db, { workflowId: id, ts: NOW - 10_000, type: "session.started", payloadJson: null });
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

describe("reconcileTranscriptDrift", () => {
  test("advances last_heartbeat when the transcript is newer than the recorded beat", () => {
    const id = seed({
      state: "running",
      transcriptPath: "/t/x.jsonl",
      lastHeartbeat: NOW - 10 * MIN,
      updatedAt: NOW - 10 * MIN,
    });
    const corrected = reconcileTranscriptDrift(baseDeps({ getAdapter: makeAdapter(NOW - 1 * MIN) }));
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
    const corrected = reconcileTranscriptDrift(baseDeps({ getAdapter: makeAdapter(NOW - 10 * MIN) }));
    expect(corrected).toBe(0);
    const row = db.query("SELECT last_heartbeat FROM workflows WHERE id = ?").get(id) as {
      last_heartbeat: number;
    };
    expect(row.last_heartbeat).toBe(NOW - 1 * MIN);
  });
});
