import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createDbDeps } from "../src/db-deps.ts";
import { makeConfig, makeDb } from "./helpers.ts";

let db: Database;
let cleanup: () => void;
beforeEach(() => {
  const made = makeDb();
  db = made.db;
  cleanup = made.cleanup;
});
afterEach(() => cleanup());

/** Insert a workflow row directly (kind-agnostic; the shared seedWorkflow is implementation-only). */
function seedRun(o: {
  id: string;
  kind: "implementation" | "recommender" | "documentation";
  repo: string;
  state?: string;
  createdAt: number;
  updatedAt?: number;
  sessionName?: string | null;
  transcriptPath?: string | null;
  prNumber?: number | null;
}): void {
  db.run(
    `INSERT INTO workflows (id, kind, repo, adapter, state, created_at, updated_at, session_name, transcript_path, pr_number)
     VALUES (?, ?, ?, 'claude', ?, ?, ?, ?, ?, ?)`,
    [
      o.id, o.kind, o.repo, o.state ?? "completed", o.createdAt, o.updatedAt ?? o.createdAt,
      o.sessionName ?? null, o.transcriptPath ?? null, o.prNumber ?? null,
    ],
  );
}

describe("createDbDeps.listRuns", () => {
  test("returns only non-implementation kinds, newest-first within kind", async () => {
    seedRun({ id: "impl1", kind: "implementation", repo: "o/r", createdAt: 100 });
    seedRun({ id: "rec1", kind: "recommender", repo: "o/r", createdAt: 100 });
    seedRun({ id: "rec2", kind: "recommender", repo: "o/r", createdAt: 200 });
    seedRun({ id: "doc1", kind: "documentation", repo: "o/r", createdAt: 150 });
    const runs = await createDbDeps({ db, config: makeConfig() }).listRuns();
    // recommender group first (newest-first), then documentation; the implementation row is excluded.
    expect(runs.map((r) => r.workflowId)).toEqual(["rec2", "rec1", "doc1"]);
    expect(runs.map((r) => r.kind)).toEqual(["recommender", "recommender", "documentation"]);
  });

  test("projects duration, active, transcript, and session fallback", async () => {
    seedRun({ id: "rec-active", kind: "recommender", repo: "o/r", state: "running", createdAt: Date.now() - 5000, sessionName: "s-rec" });
    seedRun({ id: "doc-done", kind: "documentation", repo: "o/r", state: "completed", createdAt: 1000, updatedAt: 4000, transcriptPath: "/t/x.jsonl" });
    const runs = await createDbDeps({ db, config: makeConfig() }).listRuns();
    const rec = runs.find((r) => r.workflowId === "rec-active")!;
    expect(rec).toMatchObject({ active: true, session: "s-rec", hasTranscript: false });
    expect(rec.durationMs).toBeGreaterThanOrEqual(5000);
    const doc = runs.find((r) => r.workflowId === "doc-done")!;
    expect(doc).toMatchObject({ active: false, durationMs: 3000, hasTranscript: true, session: "doc-done" }); // session falls back to id
  });

  test("outputLink: recommender → state issue, documentation → PR, else null", async () => {
    db.run(
      "INSERT INTO repo_config (repo, config_json, state_issue_number, last_synced_at) VALUES (?, ?, ?, ?)",
      ["o/r", "{}", 84, 0],
    );
    seedRun({ id: "rec", kind: "recommender", repo: "o/r", createdAt: 10 });
    seedRun({ id: "doc-pr", kind: "documentation", repo: "o/r", createdAt: 20, prNumber: 251 });
    seedRun({ id: "doc-nopr", kind: "documentation", repo: "o/r", createdAt: 10 });
    const runs = await createDbDeps({ db, config: makeConfig() }).listRuns();
    expect(runs.find((r) => r.workflowId === "rec")!.outputLink).toBe("https://github.com/o/r/issues/84");
    expect(runs.find((r) => r.workflowId === "doc-pr")!.outputLink).toBe("https://github.com/o/r/pull/251");
    expect(runs.find((r) => r.workflowId === "doc-nopr")!.outputLink).toBeNull();
  });

  test("caps at 20 per kind", async () => {
    for (let i = 0; i < 25; i++) seedRun({ id: `rec${i}`, kind: "recommender", repo: "o/r", createdAt: i });
    const runs = await createDbDeps({ db, config: makeConfig() }).listRuns();
    expect(runs.filter((r) => r.kind === "recommender")).toHaveLength(20);
  });
});
