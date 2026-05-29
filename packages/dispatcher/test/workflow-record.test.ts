import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAndMigrate } from "../src/db.ts";
import {
  addWorkflowObserver,
  clearWorkflowObservers,
  countActiveImplementationSlots,
  createWorkflowRecord,
  type CreateWorkflowRecordInput,
  finalizeParkedWorkflow,
  getCheckboxReconcileState,
  getWorkflow,
  getWorkflowSource,
  hasNonTerminalEpicWorkflow,
  listNonTerminalWorkflows,
  listRunningImplementationWorkflows,
  patchWorkflowMeta,
  promotePendingToFailed,
  readWorkflowMeta,
  setCheckboxReconcileState,
  updateWorkflow,
} from "../src/workflow-record.ts";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "middle-wfrec-"));
  db = openAndMigrate(join(dir, "db.sqlite3"));
});

afterEach(() => {
  clearWorkflowObservers(); // never leak the process-global observers across tests
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("dispatch source (#53)", () => {
  test("records and reads back source 'manual' / 'auto'; null when unset", () => {
    createWorkflowRecord(db, {
      id: "m",
      kind: "implementation",
      repo: "o/r",
      epicNumber: 1,
      adapter: "claude",
      source: "manual",
    });
    createWorkflowRecord(db, {
      id: "a",
      kind: "implementation",
      repo: "o/r",
      epicNumber: 2,
      adapter: "claude",
      source: "auto",
    });
    createWorkflowRecord(db, {
      id: "none",
      kind: "recommender",
      repo: "o/r",
      epicNumber: null,
      adapter: "claude",
    });
    expect(getWorkflowSource(db, "m")).toBe("manual");
    expect(getWorkflowSource(db, "a")).toBe("auto");
    expect(getWorkflowSource(db, "none")).toBeNull();
    expect(getWorkflowSource(db, "missing")).toBeNull();
  });
});

describe("workflow meta_json accessors", () => {
  test("readWorkflowMeta returns {} for a missing row, a null meta, and malformed JSON", () => {
    createWorkflowRecord(db, {
      id: "w",
      kind: "recommender",
      repo: "o/r",
      epicNumber: null,
      adapter: "claude",
    });
    expect(readWorkflowMeta(db, "absent")).toEqual({});
    expect(readWorkflowMeta(db, "w")).toEqual({}); // created without source → meta_json null
    db.run("UPDATE workflows SET meta_json = ? WHERE id = ?", ["{not json", "w"]);
    expect(readWorkflowMeta(db, "w")).toEqual({});
    // A non-object JSON value (e.g. a bare string) also degrades to {}.
    db.run("UPDATE workflows SET meta_json = ? WHERE id = ?", ['"a string"', "w"]);
    expect(readWorkflowMeta(db, "w")).toEqual({});
  });

  test("patchWorkflowMeta merges, preserving keys it does not set", () => {
    createWorkflowRecord(db, {
      id: "w",
      kind: "implementation",
      repo: "o/r",
      epicNumber: 1,
      adapter: "claude",
      source: "manual",
    });
    // Adding checkboxReconcile must not clobber the source written at creation.
    patchWorkflowMeta(db, "w", { checkboxReconcile: { headSha: "abc", state: { 1: true } } });
    expect(getWorkflowSource(db, "w")).toBe("manual");
    expect(readWorkflowMeta(db, "w").checkboxReconcile).toEqual({
      headSha: "abc",
      state: { 1: true },
    });
    // And patching source back must not drop checkboxReconcile.
    patchWorkflowMeta(db, "w", { source: "auto" });
    expect(getWorkflowSource(db, "w")).toBe("auto");
    expect(readWorkflowMeta(db, "w").checkboxReconcile).toEqual({
      headSha: "abc",
      state: { 1: true },
    });
  });

  test("patchWorkflowMeta does not bump updated_at — meta is scratch, not an activity signal", () => {
    // The watchdog folds updated_at into its idle-freshness baseline; a meta
    // write (the poller's checkbox-revert persist) must not reset that clock.
    createWorkflowRecord(db, {
      id: "w",
      kind: "implementation",
      repo: "o/r",
      epicNumber: 1,
      adapter: "claude",
    });
    const before = getWorkflow(db, "w")!.updatedAt;
    db.run("UPDATE workflows SET updated_at = ? WHERE id = ?", [before - 60_000, "w"]); // age it
    patchWorkflowMeta(db, "w", { checkboxReconcile: { headSha: "abc", state: {} } });
    expect(getWorkflow(db, "w")!.updatedAt).toBe(before - 60_000); // untouched
  });

  test("checkbox-reconcile state round-trips; defaults when unset", () => {
    createWorkflowRecord(db, {
      id: "w",
      kind: "implementation",
      repo: "o/r",
      epicNumber: 1,
      adapter: "claude",
    });
    expect(getCheckboxReconcileState(db, "w")).toEqual({ headSha: null, state: {} });
    setCheckboxReconcileState(db, "w", { headSha: "deadbeef", state: { 7: true, 8: false } });
    expect(getCheckboxReconcileState(db, "w")).toEqual({
      headSha: "deadbeef",
      state: { 7: true, 8: false },
    });
  });

  test("getCheckboxReconcileState sanitizes malformed nested meta back to the contract", () => {
    // readWorkflowMeta only guards the top-level shape; the nested checkboxReconcile
    // is still untrusted (hand-edited row / version skew). Inject raw meta_json that
    // bypasses the typed setter to prove the read sanitizes every malformed shape.
    createWorkflowRecord(db, {
      id: "w",
      kind: "implementation",
      repo: "o/r",
      epicNumber: 1,
      adapter: "claude",
    });
    const setMeta = (meta: unknown) =>
      db.run("UPDATE workflows SET meta_json = ? WHERE id = ?", [JSON.stringify(meta), "w"]);

    // Non-object nested value → default.
    setMeta({ checkboxReconcile: "nope" });
    expect(getCheckboxReconcileState(db, "w")).toEqual({ headSha: null, state: {} });
    // An array is typeof "object" but not a valid record shape → default (no leakage).
    setMeta({ checkboxReconcile: [1, 2] });
    expect(getCheckboxReconcileState(db, "w")).toEqual({ headSha: null, state: {} });
    // Non-string headSha coerces to null; non-object state coerces to {}.
    setMeta({ checkboxReconcile: { headSha: 123, state: "x" } });
    expect(getCheckboxReconcileState(db, "w")).toEqual({ headSha: null, state: {} });
    // A state array is rejected — no index-as-key coercion from Object.entries.
    setMeta({ checkboxReconcile: { headSha: "abc", state: [true, false] } });
    expect(getCheckboxReconcileState(db, "w")).toEqual({ headSha: "abc", state: {} });
    // Non-boolean state entries are dropped; valid boolean ones survive.
    setMeta({
      checkboxReconcile: { headSha: "abc", state: { 1: true, 2: "yes", 3: false, 4: null } },
    });
    expect(getCheckboxReconcileState(db, "w")).toEqual({
      headSha: "abc",
      state: { 1: true, 3: false },
    });
  });
});

describe("listRunningImplementationWorkflows", () => {
  const seed = (
    id: string,
    opts: {
      kind?: "implementation" | "recommender" | "documentation";
      state?: "running" | "waiting-human" | "pending";
      epicNumber?: number | null;
      worktreePath?: string | null;
    } = {},
  ) => {
    createWorkflowRecord(db, {
      id,
      kind: opts.kind ?? "implementation",
      repo: "o/r",
      epicNumber: opts.epicNumber === undefined ? 1 : opts.epicNumber,
      adapter: "claude",
    });
    const patch: Parameters<typeof updateWorkflow>[2] = { state: opts.state ?? "running" };
    if (opts.worktreePath !== null) patch.worktreePath = opts.worktreePath ?? "/wt/x";
    updateWorkflow(db, id, patch);
  };

  test("returns only running implementation rows that own both an epic and a worktree", () => {
    seed("run-1", { worktreePath: "/wt/1" });
    seed("run-2", { worktreePath: "/wt/2" });
    seed("parked", { state: "waiting-human" });
    seed("pending", { state: "pending" });
    seed("recommender", { kind: "recommender", epicNumber: null });
    seed("no-epic", { epicNumber: null });
    seed("no-worktree", { worktreePath: null });

    const ids = listRunningImplementationWorkflows(db).map((r) => r.id);
    expect(ids).toEqual(["run-1", "run-2"]);
    const first = listRunningImplementationWorkflows(db)[0]!;
    expect(first).toEqual({ id: "run-1", repo: "o/r", epicNumber: 1, worktreePath: "/wt/1" });
  });
});

describe("createWorkflowRecord", () => {
  test("inserts a pending implementation row carrying epic_number", () => {
    createWorkflowRecord(db, {
      id: "exec-1",
      kind: "implementation",
      repo: "thejustinwalsh/middle",
      epicNumber: 6,
      adapter: "claude",
    });
    const row = getWorkflow(db, "exec-1");
    expect(row).not.toBeNull();
    expect(row!.state).toBe("pending");
    expect(row!.epicNumber).toBe(6);
    expect(row!.repo).toBe("thejustinwalsh/middle");
    expect(row!.bunqueueExecutionId).toBe("exec-1");
    expect(row!.controlledBy).toBe("middle");
  });

  // #108: the step that calls this runs under bunqueue's default retry. A
  // retried record-creating step re-runs the INSERT for the same execution id;
  // a plain INSERT would throw UNIQUE and mask the real (downstream) error. The
  // INSERT must be idempotent so the second call is a no-op.
  test("a second create with the same id is a no-op (idempotent on retry), not a UNIQUE error", () => {
    createWorkflowRecord(db, {
      id: "exec-retry",
      kind: "implementation",
      repo: "o/r",
      epicNumber: 6,
      adapter: "claude",
    });
    // Advance the row the way prepare-worktree does after the INSERT, so we can
    // prove the retry doesn't reset it.
    updateWorkflow(db, "exec-retry", { worktreePath: "/wt/exec-retry", state: "launching" });

    // The retry: same id, but with fields that WOULD differ if the INSERT ran.
    expect(() =>
      createWorkflowRecord(db, {
        id: "exec-retry",
        kind: "recommender",
        repo: "other/repo",
        epicNumber: 99,
        adapter: "codex",
      }),
    ).not.toThrow();

    // The original row is untouched — the second INSERT was ignored, not applied.
    const row = getWorkflow(db, "exec-retry");
    expect(row!.kind).toBe("implementation");
    expect(row!.repo).toBe("o/r");
    expect(row!.epicNumber).toBe(6);
    expect(row!.adapter).toBe("claude");
    expect(row!.state).toBe("launching");
    expect(row!.worktreePath).toBe("/wt/exec-retry");
  });

  // The no-op is scoped to the id PK conflict, NOT a blanket `INSERT OR IGNORE`:
  // a genuine CHECK/NOT-NULL violation is a real bug and must still throw rather
  // than be silently swallowed. (Cast past the typed surface to force one.)
  test("a non-PK constraint violation (bad kind) still throws — not swallowed", () => {
    expect(() =>
      createWorkflowRecord(db, {
        id: "exec-bad-kind",
        kind: "nonsense" as CreateWorkflowRecordInput["kind"],
        repo: "o/r",
        epicNumber: 1,
        adapter: "claude",
      }),
    ).toThrow();
    expect(getWorkflow(db, "exec-bad-kind")).toBeNull();
  });
});

describe("countActiveImplementationSlots", () => {
  const mk = (
    id: string,
    kind: "implementation" | "recommender",
    adapter: string,
    epic: number | null,
  ) => createWorkflowRecord(db, { id, kind, repo: "o/r", epicNumber: epic, adapter });

  test("counts non-terminal implementation rows, grouped by adapter", () => {
    mk("a", "implementation", "claude", 1);
    mk("b", "implementation", "claude", 2);
    mk("c", "implementation", "codex", 3);
    expect(countActiveImplementationSlots(db)).toEqual({
      total: 3,
      perAdapter: { claude: 2, codex: 1 },
    });
  });

  test("excludes terminal implementation rows", () => {
    mk("a", "implementation", "claude", 1);
    mk("b", "implementation", "claude", 2);
    updateWorkflow(db, "b", { state: "completed" });
    expect(countActiveImplementationSlots(db)).toEqual({ total: 1, perAdapter: { claude: 1 } });
  });

  test("excludes the recommender's own row — its dedicated slot is not a dispatch slot", () => {
    mk("rec", "recommender", "claude", null);
    expect(countActiveImplementationSlots(db)).toEqual({ total: 0, perAdapter: {} });
    mk("a", "implementation", "claude", 1);
    expect(countActiveImplementationSlots(db)).toEqual({ total: 1, perAdapter: { claude: 1 } });
  });
});

describe("updateWorkflow", () => {
  test("transitions state and bumps updated_at", async () => {
    createWorkflowRecord(db, {
      id: "exec-1",
      kind: "implementation",
      repo: "o/r",
      epicNumber: 6,
      adapter: "claude",
    });
    const before = getWorkflow(db, "exec-1")!.updatedAt;
    await Bun.sleep(2);
    updateWorkflow(db, "exec-1", { state: "launching" });
    const after = getWorkflow(db, "exec-1")!;
    expect(after.state).toBe("launching");
    expect(after.updatedAt).toBeGreaterThan(before);
  });

  test("patches session fields without disturbing others", () => {
    createWorkflowRecord(db, {
      id: "exec-1",
      kind: "implementation",
      repo: "o/r",
      epicNumber: 6,
      adapter: "claude",
    });
    updateWorkflow(db, "exec-1", { worktreePath: "/wt/issue-6" });
    updateWorkflow(db, "exec-1", {
      state: "running",
      sessionName: "middle-6",
      sessionId: "sess-abc",
      transcriptPath: "/t/abc.jsonl",
    });
    const row = getWorkflow(db, "exec-1")!;
    expect(row.state).toBe("running");
    expect(row.worktreePath).toBe("/wt/issue-6");
    expect(row.sessionName).toBe("middle-6");
    expect(row.sessionId).toBe("sess-abc");
    expect(row.transcriptPath).toBe("/t/abc.jsonl");
  });

  test("a no-op patch leaves the row intact", () => {
    createWorkflowRecord(db, {
      id: "exec-1",
      kind: "implementation",
      repo: "o/r",
      epicNumber: 6,
      adapter: "claude",
    });
    updateWorkflow(db, "exec-1", {});
    expect(getWorkflow(db, "exec-1")!.state).toBe("pending");
  });
});

describe("getWorkflow", () => {
  test("returns null for an unknown id", () => {
    expect(getWorkflow(db, "nope")).toBeNull();
  });
});

describe("hasNonTerminalEpicWorkflow", () => {
  test("true while an implementation Epic workflow is non-terminal, false once terminal", () => {
    createWorkflowRecord(db, {
      id: "a",
      kind: "implementation",
      repo: "o/r",
      epicNumber: 7,
      adapter: "claude",
    });
    expect(hasNonTerminalEpicWorkflow(db, "o/r", 7)).toBe(true);
    updateWorkflow(db, "a", { state: "completed" });
    expect(hasNonTerminalEpicWorkflow(db, "o/r", 7)).toBe(false);
  });

  test("scopes by repo and epic; a recommender row never collides", () => {
    createWorkflowRecord(db, {
      id: "a",
      kind: "implementation",
      repo: "o/r",
      epicNumber: 7,
      adapter: "claude",
    });
    expect(hasNonTerminalEpicWorkflow(db, "o/r", 8)).toBe(false); // different epic
    expect(hasNonTerminalEpicWorkflow(db, "x/y", 7)).toBe(false); // different repo
    createWorkflowRecord(db, {
      id: "rec",
      kind: "recommender",
      repo: "o/r",
      epicNumber: 9,
      adapter: "claude",
    });
    expect(hasNonTerminalEpicWorkflow(db, "o/r", 9)).toBe(false); // recommender doesn't claim the slot
  });
});

describe("listNonTerminalWorkflows", () => {
  test("returns id/repo/epic/state for non-terminal implementation rows only", () => {
    createWorkflowRecord(db, {
      id: "a",
      kind: "implementation",
      repo: "o/r",
      epicNumber: 1,
      adapter: "claude",
    });
    createWorkflowRecord(db, {
      id: "b",
      kind: "implementation",
      repo: "o/r",
      epicNumber: 2,
      adapter: "claude",
    });
    createWorkflowRecord(db, {
      id: "rec",
      kind: "recommender",
      repo: "o/r",
      epicNumber: null,
      adapter: "claude",
    });
    updateWorkflow(db, "a", { state: "waiting-human" });
    updateWorkflow(db, "b", { state: "completed" }); // terminal → excluded
    const rows = listNonTerminalWorkflows(db);
    expect(rows).toEqual([{ id: "a", repo: "o/r", epicNumber: 1, state: "waiting-human" }]);
  });
});

describe("workflow observers", () => {
  test("notifies the observer of each patch, and stops after dispose", () => {
    createWorkflowRecord(db, {
      id: "a",
      kind: "implementation",
      repo: "o/r",
      epicNumber: 1,
      adapter: "claude",
    });
    const seen: Array<{ id: string; state?: string }> = [];
    const dispose = addWorkflowObserver((id, patch) => seen.push({ id, state: patch.state }));
    try {
      updateWorkflow(db, "a", { state: "waiting-human" });
      updateWorkflow(db, "a", { worktreePath: "/wt" }); // no state → still observed
      expect(seen).toEqual([
        { id: "a", state: "waiting-human" },
        { id: "a", state: undefined },
      ]);
    } finally {
      dispose();
    }
    updateWorkflow(db, "a", { state: "completed" });
    expect(seen).toHaveLength(2); // no further notifications after dispose
  });

  test("a throwing observer does not break the DB write", () => {
    createWorkflowRecord(db, {
      id: "a",
      kind: "implementation",
      repo: "o/r",
      epicNumber: 1,
      adapter: "claude",
    });
    const dispose = addWorkflowObserver(() => {
      throw new Error("observer boom");
    });
    try {
      updateWorkflow(db, "a", { state: "launching" });
      expect(getWorkflow(db, "a")!.state).toBe("launching");
    } finally {
      dispose();
    }
  });

  test("addWorkflowObserver fans out to every observer; disposers independent", () => {
    createWorkflowRecord(db, {
      id: "a",
      kind: "implementation",
      repo: "o/r",
      epicNumber: 1,
      adapter: "claude",
    });
    const seenA: Array<{ id: string; state?: string }> = [];
    const seenB: Array<{ id: string; state?: string }> = [];
    const disposeA = addWorkflowObserver((id, patch) => seenA.push({ id, state: patch.state }));
    const disposeB = addWorkflowObserver((id, patch) => seenB.push({ id, state: patch.state }));

    updateWorkflow(db, "a", { state: "running" });
    // Both observers saw the same (id, patch).
    expect(seenA).toEqual([{ id: "a", state: "running" }]);
    expect(seenB).toEqual([{ id: "a", state: "running" }]);

    // Dispose one; only the remaining observer fires on the next write.
    disposeA();
    updateWorkflow(db, "a", { state: "waiting-human" });
    expect(seenA).toHaveLength(1); // unchanged
    expect(seenB).toEqual([
      { id: "a", state: "running" },
      { id: "a", state: "waiting-human" },
    ]);
    disposeB();
  });

  test("the finalize path notifies observers on a real transition only", () => {
    createWorkflowRecord(db, {
      id: "a",
      kind: "implementation",
      repo: "o/r",
      epicNumber: 1,
      adapter: "claude",
    });
    updateWorkflow(db, "a", { state: "waiting-human" });
    const seen: Array<{ id: string; state?: string }> = [];
    const dispose = addWorkflowObserver((id, patch) => seen.push({ id, state: patch.state }));
    try {
      expect(finalizeParkedWorkflow(db, "a", "completed")).toBe(true);
      expect(seen).toEqual([{ id: "a", state: "completed" }]);
      // No longer waiting-human → no transition → no notification.
      expect(finalizeParkedWorkflow(db, "a", "failed")).toBe(false);
      expect(seen).toHaveLength(1);
    } finally {
      dispose();
    }
  });
});

describe("promotePendingToFailed — orphaned prepare-worktree (issue #179)", () => {
  function seed(id: string): void {
    createWorkflowRecord(db, {
      id,
      kind: "implementation",
      repo: "o/r",
      epicNumber: 1,
      adapter: "claude",
    });
  }

  test("flips a still-pending row to failed and reports the transition", () => {
    seed("a");
    expect(getWorkflow(db, "a")!.state).toBe("pending");
    expect(promotePendingToFailed(db, "a")).toBe(true);
    expect(getWorkflow(db, "a")!.state).toBe("failed");
    // A terminal row no longer blocks the Epic's next dispatch (the 409 guard).
    expect(hasNonTerminalEpicWorkflow(db, "o/r", 1)).toBe(false);
  });

  test("no-ops on a row already past pending (e.g. a later step's compensated failure)", () => {
    seed("a");
    updateWorkflow(db, "a", { state: "compensated" });
    expect(promotePendingToFailed(db, "a")).toBe(false);
    expect(getWorkflow(db, "a")!.state).toBe("compensated"); // not clobbered to failed
  });

  test("no-ops on a launching row — the launch step already advanced it", () => {
    seed("a");
    updateWorkflow(db, "a", { state: "launching" });
    expect(promotePendingToFailed(db, "a")).toBe(false);
    expect(getWorkflow(db, "a")!.state).toBe("launching");
  });

  test("no-ops on an unknown id", () => {
    expect(promotePendingToFailed(db, "missing")).toBe(false);
  });

  test("does NOT touch a pending recommender row — it legitimately sits at pending through build-prompt, where compensation owns the terminal state", () => {
    createWorkflowRecord(db, {
      id: "rec",
      kind: "recommender",
      repo: "o/r",
      epicNumber: null,
      adapter: "claude",
    });
    expect(promotePendingToFailed(db, "rec")).toBe(false);
    expect(getWorkflow(db, "rec")!.state).toBe("pending"); // not clobbered to failed
  });

  test("does NOT touch a pending documentation row (same reason as recommender)", () => {
    createWorkflowRecord(db, {
      id: "doc",
      kind: "documentation",
      repo: "o/r",
      epicNumber: null,
      adapter: "claude",
    });
    expect(promotePendingToFailed(db, "doc")).toBe(false);
    expect(getWorkflow(db, "doc")!.state).toBe("pending");
  });

  test("notifies observers only on a real transition", () => {
    seed("a");
    const seen: Array<{ id: string; state?: string }> = [];
    const dispose = addWorkflowObserver((id, patch) => seen.push({ id, state: patch.state }));
    try {
      expect(promotePendingToFailed(db, "a")).toBe(true);
      expect(seen).toEqual([{ id: "a", state: "failed" }]);
      // Idempotent: a second call no-ops (row is failed, not pending) → no notify.
      expect(promotePendingToFailed(db, "a")).toBe(false);
      expect(seen).toHaveLength(1);
    } finally {
      dispose();
    }
  });
});
