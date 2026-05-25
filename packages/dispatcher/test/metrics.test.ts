import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAndMigrate } from "../src/db.ts";
import { collectMetrics, renderPrometheus } from "../src/metrics.ts";
import { setRateLimited } from "../src/rate-limits.ts";
import { createWorkflowRecord, updateWorkflow } from "../src/workflow-record.ts";

let scratch: string;
let db: Database;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "middle-metrics-"));
  db = openAndMigrate(join(scratch, "db.sqlite3"));
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

function seed(
  id: string,
  repo: string,
  kind: "implementation" | "recommender",
  adapter: string,
  state: Parameters<typeof updateWorkflow>[2]["state"],
): void {
  createWorkflowRecord(db, { id, kind, repo, epicNumber: 1, adapter });
  if (state) updateWorkflow(db, id, { state });
}

describe("collectMetrics", () => {
  test("empty db → zeroed snapshot", () => {
    const m = collectMetrics(db, 123);
    expect(m.generatedAt).toBe(123);
    expect(m.workflows).toEqual([]);
    expect(m.slots).toEqual({ total: 0, perAdapter: {} });
    expect(m.rateLimits).toEqual([]);
    expect(m.totals).toEqual({ all: 0, active: 0, waitingHuman: 0 });
  });

  test("groups workflows by (repo, kind, state) and rolls up totals", () => {
    seed("a", "o/r", "implementation", "claude", "running");
    seed("b", "o/r", "implementation", "claude", "running");
    seed("c", "o/r", "implementation", "codex", "waiting-human");
    seed("d", "o/r", "recommender", "claude", "completed");

    const m = collectMetrics(db);
    expect(m.workflows).toEqual([
      { repo: "o/r", kind: "implementation", state: "running", count: 2 },
      { repo: "o/r", kind: "implementation", state: "waiting-human", count: 1 },
      { repo: "o/r", kind: "recommender", state: "completed", count: 1 },
    ]);
    // active = non-terminal implementation slots (the recommender row is excluded).
    expect(m.slots).toEqual({ total: 3, perAdapter: { claude: 2, codex: 1 } });
    expect(m.totals).toEqual({ all: 4, active: 3, waitingHuman: 1 });
  });

  test("a completed implementation frees its slot but stays counted in totals", () => {
    seed("a", "o/r", "implementation", "claude", "completed");
    const m = collectMetrics(db);
    expect(m.slots.total).toBe(0); // terminal → no slot held
    expect(m.totals.all).toBe(1); // still a row
  });

  test("surfaces rate-limit standing per adapter", () => {
    setRateLimited(db, { adapter: "claude", resetAt: 999, source: "test" });
    const m = collectMetrics(db);
    expect(m.rateLimits).toEqual([{ adapter: "claude", status: "RATE_LIMITED", resetAt: 999 }]);
  });
});

describe("renderPrometheus", () => {
  test("emits gauges with HELP/TYPE and a trailing newline", () => {
    seed("a", "o/r", "implementation", "claude", "running");
    setRateLimited(db, { adapter: "claude", resetAt: 999, source: "test" });
    const text = renderPrometheus(collectMetrics(db));

    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain("# TYPE middle_workflows gauge");
    expect(text).toContain('middle_workflows{repo="o/r",kind="implementation",state="running"} 1');
    expect(text).toContain('middle_slots_active{adapter="claude"} 1');
    expect(text).toContain("middle_slots_active_total 1");
    expect(text).toContain('middle_rate_limited{adapter="claude"} 1');
    expect(text).toContain("middle_workflows_total 1");
    expect(text).toContain("middle_workflows_waiting_human 0");
  });

  test("an AVAILABLE adapter renders rate_limited 0", () => {
    setRateLimited(db, { adapter: "codex", resetAt: 1, source: "test" });
    // Flip back to available.
    db.run("UPDATE rate_limit_state SET status = 'AVAILABLE' WHERE adapter = 'codex'");
    expect(renderPrometheus(collectMetrics(db))).toContain(
      'middle_rate_limited{adapter="codex"} 0',
    );
  });

  test("escapes special characters in label values", () => {
    seed("a", 'o/"r"', "implementation", "claude", "running");
    expect(renderPrometheus(collectMetrics(db))).toContain('repo="o/\\"r\\""');
  });
});
