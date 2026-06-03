import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EpicListItem, EpicGateway } from "../src/github.ts";
import { readEpics, refreshEpics } from "../src/epics-cache.ts";
import { openAndMigrate } from "../src/db.ts";
import type { Database } from "bun:sqlite";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "middle-epics-"));
  db = openAndMigrate(join(dir, "db.sqlite3"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function fakeGitHub(epics: EpicListItem[]): EpicGateway {
  return { listOpenEpics: async () => epics } as unknown as EpicGateway;
}

describe("epics-cache", () => {
  test("refreshEpics upserts open Epics and readEpics returns them newest-first", async () => {
    await refreshEpics(
      db,
      "o/r",
      fakeGitHub([
        {
          ref: "10",
          number: 10,
          title: "A",
          state: "open",
          labels: ["epic"],
          subTotal: 3,
          subClosed: 1,
        },
        { ref: "20", number: 20, title: "B", state: "open", labels: [], subTotal: 2, subClosed: 2 },
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
    await refreshEpics(
      db,
      "o/r",
      fakeGitHub([
        { ref: "10", number: 10, title: "A", state: "open", labels: [], subTotal: 1, subClosed: 0 },
      ]),
    );
    await refreshEpics(db, "o/r", fakeGitHub([])); // 10 no longer open
    expect(readEpics(db, "o/r")).toEqual([]);
    const raw = db.query("SELECT state FROM epics WHERE repo='o/r' AND number=10").get() as {
      state: string;
    };
    expect(raw.state).toBe("closed");
  });

  test("a closed Epic that reappears is reopened and visible again", async () => {
    // Seed #10 as open.
    await refreshEpics(
      db,
      "o/r",
      fakeGitHub([
        { ref: "10", number: 10, title: "A", state: "open", labels: [], subTotal: 1, subClosed: 0 },
      ]),
    );
    // Refresh with empty list — #10 is now closed.
    await refreshEpics(db, "o/r", fakeGitHub([]));
    expect(readEpics(db, "o/r")).toEqual([]);
    // Refresh again with #10 present — it must reopen.
    await refreshEpics(
      db,
      "o/r",
      fakeGitHub([
        { ref: "10", number: 10, title: "A", state: "open", labels: [], subTotal: 1, subClosed: 0 },
      ]),
    );
    const rows = readEpics(db, "o/r");
    expect(rows.map((r) => r.number)).toEqual([10]);
    const raw = db.query("SELECT state FROM epics WHERE repo='o/r' AND number=10").get() as {
      state: string;
    };
    expect(raw.state).toBe("open");
  });

  test("caches a file-mode Epic (slug ref, null number) and surfaces it in readEpics (#200)", async () => {
    await refreshEpics(
      db,
      "o/r",
      fakeGitHub([
        {
          ref: "rollout-epic-store",
          number: null,
          title: "Roll out the store",
          state: "open",
          labels: ["epic"],
          subTotal: 5,
          subClosed: 2,
        },
      ]),
    );
    const rows = readEpics(db, "o/r");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ref: "rollout-epic-store",
      number: null,
      title: "Roll out the store",
      subTotal: 5,
      subClosed: 2,
      labels: ["epic"],
    });
  });

  test("mixed github + file Epics: github (by number desc) first, file (null number) after", async () => {
    await refreshEpics(
      db,
      "o/r",
      fakeGitHub([
        {
          ref: "10",
          number: 10,
          title: "ten",
          state: "open",
          labels: [],
          subTotal: 1,
          subClosed: 0,
        },
        {
          ref: "rollout-epic-store",
          number: null,
          title: "file epic",
          state: "open",
          labels: [],
          subTotal: 0,
          subClosed: 0,
        },
        {
          ref: "20",
          number: 20,
          title: "twenty",
          state: "open",
          labels: [],
          subTotal: 1,
          subClosed: 0,
        },
      ]),
    );
    // github Epics by number desc, then the file Epic (NULL number sorts last in DESC).
    expect(readEpics(db, "o/r").map((r) => r.ref)).toEqual(["20", "10", "rollout-epic-store"]);
  });

  test("a file Epic that vanishes is marked closed by its slug ref", async () => {
    await refreshEpics(
      db,
      "o/r",
      fakeGitHub([
        {
          ref: "rollout-epic-store",
          number: null,
          title: "f",
          state: "open",
          labels: [],
          subTotal: 0,
          subClosed: 0,
        },
      ]),
    );
    await refreshEpics(db, "o/r", fakeGitHub([])); // gone from the open set
    expect(readEpics(db, "o/r")).toEqual([]);
    const raw = db
      .query("SELECT state FROM epics WHERE repo='o/r' AND ref='rollout-epic-store'")
      .get() as { state: string };
    expect(raw.state).toBe("closed");
  });

  test("refresh is repo-scoped — another repo's rows are untouched", async () => {
    await refreshEpics(
      db,
      "o/a",
      fakeGitHub([
        { ref: "1", number: 1, title: "A", state: "open", labels: [], subTotal: 1, subClosed: 0 },
      ]),
    );
    await refreshEpics(db, "o/b", fakeGitHub([]));
    expect(readEpics(db, "o/a").map((r) => r.number)).toEqual([1]);
  });
});
