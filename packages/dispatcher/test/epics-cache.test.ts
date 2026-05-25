import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { EpicListItem, GitHubGateway } from "../src/github.ts";
import { readEpics, refreshEpics } from "../src/epics-cache.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE epics (
    repo TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL,
    state TEXT NOT NULL, labels_json TEXT NOT NULL DEFAULT '[]',
    sub_total INTEGER NOT NULL DEFAULT 0, sub_closed INTEGER NOT NULL DEFAULT 0,
    gh_updated_at TEXT, last_refreshed INTEGER NOT NULL,
    PRIMARY KEY (repo, number));`);
  return db;
}

function fakeGitHub(epics: EpicListItem[]): GitHubGateway {
  return { listOpenEpics: async () => epics } as unknown as GitHubGateway;
}

describe("epics-cache", () => {
  test("refreshEpics upserts open Epics and readEpics returns them newest-first", async () => {
    const db = freshDb();
    await refreshEpics(
      db,
      "o/r",
      fakeGitHub([
        { number: 10, title: "A", state: "open", labels: ["epic"], subTotal: 3, subClosed: 1 },
        { number: 20, title: "B", state: "open", labels: [], subTotal: 2, subClosed: 2 },
      ]),
    );
    const rows = readEpics(db, "o/r");
    expect(rows.map((r) => r.number)).toEqual([20, 10]);
    expect(rows[0]).toMatchObject({
      number: 20,
      title: "B",
      subTotal: 2,
      subClosed: 2,
      labels: [],
    });
    expect(rows[1]).toMatchObject({ number: 10, labels: ["epic"], subTotal: 3, subClosed: 1 });
  });

  test("an Epic that vanishes from the open set is marked closed and dropped from readEpics", async () => {
    const db = freshDb();
    await refreshEpics(
      db,
      "o/r",
      fakeGitHub([
        { number: 10, title: "A", state: "open", labels: [], subTotal: 1, subClosed: 0 },
      ]),
    );
    await refreshEpics(db, "o/r", fakeGitHub([])); // 10 no longer open
    expect(readEpics(db, "o/r")).toEqual([]);
    const raw = db.query("SELECT state FROM epics WHERE repo='o/r' AND number=10").get() as {
      state: string;
    };
    expect(raw.state).toBe("closed");
  });

  test("refresh is repo-scoped — another repo's rows are untouched", async () => {
    const db = freshDb();
    await refreshEpics(
      db,
      "o/a",
      fakeGitHub([{ number: 1, title: "A", state: "open", labels: [], subTotal: 1, subClosed: 0 }]),
    );
    await refreshEpics(db, "o/b", fakeGitHub([]));
    expect(readEpics(db, "o/a").map((r) => r.number)).toEqual([1]);
  });
});
