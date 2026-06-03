import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAndMigrate } from "../src/db.ts";
import { HookServer } from "../src/hook-server.ts";
import { DbHookStore, serializePayload } from "../src/hook-store.ts";
import { createWorkflowRecord, getWorkflow, updateWorkflow } from "../src/workflow-record.ts";

let scratch: string;
let db: Database;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "middle-store-"));
  db = openAndMigrate(join(scratch, "db.sqlite3"));
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** Seed an active workflow owning `sessionName` with `token`, return its id. */
function seedSession(sessionName: string, token: string): string {
  const id = crypto.randomUUID();
  createWorkflowRecord(db, {
    id,
    kind: "implementation",
    repo: "thejustinwalsh/middle",
    epicRef: "14",
    adapter: "claude",
  });
  updateWorkflow(db, id, { state: "running", sessionName, sessionToken: token });
  return id;
}

function eventRows(workflowId: string): Array<{ type: string; payload_json: string | null }> {
  return db
    .query("SELECT type, payload_json FROM events WHERE workflow_id = ? ORDER BY id")
    .all(workflowId) as Array<{ type: string; payload_json: string | null }>;
}

describe("DbHookStore — resolveSessionToken", () => {
  test("returns the token of the active workflow owning the session", () => {
    seedSession("middle-14", "tok-14");
    expect(new DbHookStore(db).resolveSessionToken("middle-14")).toBe("tok-14");
  });

  test("returns null for an unknown session", () => {
    expect(new DbHookStore(db).resolveSessionToken("middle-nope")).toBeNull();
  });

  test("ignores terminal workflows that previously held the deterministic session name", () => {
    const id = seedSession("middle-14", "old-tok");
    updateWorkflow(db, id, { state: "completed" });
    // a fresh dispatch reusing the same session name
    seedSession("middle-14", "new-tok");
    expect(new DbHookStore(db).resolveSessionToken("middle-14")).toBe("new-tok");
  });
});

describe("DbHookStore — record", () => {
  test("writes an events row for every hook", () => {
    const id = seedSession("middle-14", "tok");
    const store = new DbHookStore(db);
    store.record("turn.started", "middle-14", { hook_event_name: "UserPromptSubmit" });
    store.record("agent.notification", "middle-14", {});
    const rows = eventRows(id);
    expect(rows.map((r) => r.type)).toEqual(["turn.started", "agent.notification"]);
  });

  test("tool.pre and tool.post advance last_heartbeat", () => {
    const id = seedSession("middle-14", "tok");
    let clock = 1_000;
    const store = new DbHookStore(db, () => clock);
    expect(getWorkflow(db, id)!.state).toBe("running");
    expect(db.query("SELECT last_heartbeat FROM workflows WHERE id = ?").get(id)).toEqual({
      last_heartbeat: null,
    });

    clock = 5_000;
    store.record("tool.pre", "middle-14", { tool: "Bash" });
    expect(db.query("SELECT last_heartbeat FROM workflows WHERE id = ?").get(id)).toEqual({
      last_heartbeat: 5_000,
    });

    clock = 9_000;
    store.record("tool.post", "middle-14", { tool: "Bash" });
    expect(db.query("SELECT last_heartbeat FROM workflows WHERE id = ?").get(id)).toEqual({
      last_heartbeat: 9_000,
    });
  });

  test("a non-tool event records but does not advance last_heartbeat", () => {
    const id = seedSession("middle-14", "tok");
    let clock = 5_000;
    const store = new DbHookStore(db, () => clock);
    store.record("tool.pre", "middle-14", {});
    clock = 9_000;
    store.record("agent.notification", "middle-14", {});
    expect(db.query("SELECT last_heartbeat FROM workflows WHERE id = ?").get(id)).toEqual({
      last_heartbeat: 5_000, // unchanged by the notification
    });
  });

  test("session.started writes session_id + transcript_path onto the workflow", () => {
    const id = seedSession("middle-14", "tok");
    new DbHookStore(db).record("session.started", "middle-14", {
      session_id: "sess-xyz",
      transcript_path: "/home/u/.claude/projects/p/sess-xyz.jsonl",
    });
    const row = getWorkflow(db, id)!;
    expect(row.sessionId).toBe("sess-xyz");
    expect(row.transcriptPath).toBe("/home/u/.claude/projects/p/sess-xyz.jsonl");
  });

  test("an unmatchable session is dropped, not crashed on, and writes nothing", () => {
    const id = seedSession("middle-14", "tok");
    const store = new DbHookStore(db);
    expect(() => store.record("tool.pre", "middle-GHOST", {})).not.toThrow();
    expect(eventRows(id)).toHaveLength(0);
    expect(db.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: 0 });
  });

  test("oversized payloads are truncated before storage", () => {
    const id = seedSession("middle-14", "tok");
    const big = "x".repeat(20 * 1024);
    new DbHookStore(db).record("tool.post", "middle-14", { blob: big });
    const stored = eventRows(id)[0]!.payload_json!;
    expect(stored.length).toBeLessThan(20 * 1024);
    expect(stored).toEndWith("…[truncated]");
  });
});

describe("HookServer wired to DbHookStore — end to end into SQLite", () => {
  test("an authenticated POST flows through the server into the events table + heartbeat", async () => {
    const id = seedSession("middle-14", "tok-14");
    const server = new HookServer(new DbHookStore(db));
    server.start(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/hooks/tool.post`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Middle-Session": "middle-14",
          "X-Middle-Token": "tok-14",
        },
        body: JSON.stringify({ tool: "Edit" }),
      });
      expect(res.status).toBe(200);
      expect(eventRows(id).map((r) => r.type)).toEqual(["tool.post"]);
      const beat = db.query("SELECT last_heartbeat FROM workflows WHERE id = ?").get(id) as {
        last_heartbeat: number | null;
      };
      expect(beat.last_heartbeat).not.toBeNull();
    } finally {
      server.stop();
    }
  });
});

describe("serializePayload", () => {
  test("returns compact JSON for a small payload", () => {
    expect(serializePayload({ a: 1 })).toBe('{"a":1}');
  });

  test("clips and marks a payload over 16KB", () => {
    const out = serializePayload({ blob: "y".repeat(20 * 1024) });
    expect(Buffer.byteLength(out.replace("…[truncated]", ""), "utf8")).toBeLessThanOrEqual(
      16 * 1024,
    );
    expect(out).toEndWith("…[truncated]");
  });
});
