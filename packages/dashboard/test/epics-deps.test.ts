import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createDbDeps } from "../src/db-deps.ts";
import { makeConfig, makeDb, seedWorkflow } from "./helpers.ts";

let db: Database;
let cleanup: () => void;
beforeEach(() => {
  const made = makeDb();
  db = made.db;
  cleanup = made.cleanup;
});
afterEach(() => cleanup());

function seedEpic(
  repo: string,
  number: number,
  title: string,
  total: number,
  closed: number,
  labels: string[] = [],
): void {
  db.run(
    `INSERT INTO epics (repo, number, title, state, labels_json, sub_total, sub_closed, last_refreshed)
     VALUES (?, ?, ?, 'open', ?, ?, ?, 0)`,
    [repo, number, title, JSON.stringify(labels), total, closed],
  );
}

// A minimal valid state-issue body (all 7 sections, correct schema format).
const STATE_BODY = [
  "<!-- AGENT-QUEUE-STATE v1 -->",
  "<!-- generated: 2026-05-25T00:00:00Z · run: 0badf00d · interval: 30m -->",
  "<!-- owners: recommender=full-body, dispatcher=in-flight,rate-limits,slot-usage -->",
  "",
  "## Ready to dispatch",
  "",
  "| Rank | Epic | Adapter | Sub-issues | Reason |",
  "| --- | --- | --- | --- | --- |",
  "| 1 | #247 OAuth | claude | 4 | `ranked` |",
  "",
  "## Needs human input",
  "",
  "- **#247 awaiting reply** — answer the window question · [link](http://x)",
  "",
  "## Blocked",
  "",
  "## In-flight",
  "",
  "- _no agents in flight_",
  "",
  "## Excluded",
  "",
  "## Rate limits",
  "",
  "- claude: AVAILABLE",
  "- codex: AVAILABLE",
  "- github: AVAILABLE",
  "",
  "## Slot usage",
  "",
  "- claude: 0/2",
  "- total: 0/3",
  "- global: 0/3",
  "",
  "<!-- /AGENT-QUEUE-STATE -->",
].join("\n");

describe("createDbDeps.listEpics", () => {
  test("joins cache progress + state-issue decision/recommendation + free slots", async () => {
    seedEpic("o/r", 247, "OAuth", 4, 2, ["epic"]);
    db.run(
      "INSERT INTO repo_config (repo, config_json, state_issue_number, last_synced_at) VALUES (?, ?, ?, ?)",
      ["o/r", "{}", 1, 0],
    );
    const deps = createDbDeps({
      db,
      config: makeConfig(),
      stateGateway: { readBody: async () => STATE_BODY },
    });
    const cards = await deps.listEpics("o/r");
    expect(cards).toHaveLength(1);
    const c = cards[0]!;
    expect(c).toMatchObject({
      number: 247,
      title: "OAuth",
      progress: { closed: 2, total: 4 },
      runner: null,
    });
    expect(c.decision).toEqual({
      label: "awaiting reply",
      oneLiner: "answer the window question",
      link: "http://x",
    });
    expect(c.dispatch.inFlight).toBe(false);
    expect(c.dispatch.recommendedAdapter).toBe("claude");
    expect(c.dispatch.freeSlots).toContainEqual({ adapter: "claude", available: true });
  });

  test("an in-flight workflow surfaces as the runner and flips inFlight", async () => {
    seedEpic("o/r", 9, "X", 2, 0);
    seedWorkflow(db, {
      id: "wf1",
      repo: "o/r",
      epicNumber: 9,
      adapter: "claude",
      state: "running",
      sessionName: "o-r-9",
      currentSubIssue: 1,
    });
    const deps = createDbDeps({ db, config: makeConfig() });
    const c = (await deps.listEpics("o/r"))[0]!;
    expect(c.runner).toMatchObject({
      adapter: "claude",
      state: "running",
      currentSubIssue: 1,
      session: "o-r-9",
    });
    expect(c.dispatch.inFlight).toBe(true);
  });

  test("dispatchEpic + refreshEpics delegate to the injected callbacks", async () => {
    const deps = createDbDeps({
      db,
      config: makeConfig(),
      dispatch: async (repo, n, adapter) => ({ status: 200, body: `${repo}:${n}:${adapter}` }),
      refreshEpicsTrigger: async (repo) => ({ status: 200, body: repo }),
    });
    expect(await deps.dispatchEpic!("o/r", 7, "claude")).toEqual({
      status: 200,
      body: "o/r:7:claude",
    });
    expect(await deps.refreshEpics!("o/r")).toEqual({ status: 200, body: "o/r" });
  });
});
