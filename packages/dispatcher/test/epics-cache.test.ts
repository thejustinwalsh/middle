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

  test("a closed Epic that reappears is reopened and visible again", async () => {
    // Seed #10 as open.
    await refreshEpics(
      db,
      "o/r",
      fakeGitHub([
        { number: 10, title: "A", state: "open", labels: [], subTotal: 1, subClosed: 0 },
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
        { number: 10, title: "A", state: "open", labels: [], subTotal: 1, subClosed: 0 },
      ]),
    );
    const rows = readEpics(db, "o/r");
    expect(rows.map((r) => r.number)).toEqual([10]);
    const raw = db.query("SELECT state FROM epics WHERE repo='o/r' AND number=10").get() as {
      state: string;
    };
    expect(raw.state).toBe("open");
  });

  test("refresh is repo-scoped — another repo's rows are untouched", async () => {
    await refreshEpics(
      db,
      "o/a",
      fakeGitHub([{ number: 1, title: "A", state: "open", labels: [], subTotal: 1, subClosed: 0 }]),
    );
    await refreshEpics(db, "o/b", fakeGitHub([]));
    expect(readEpics(db, "o/a").map((r) => r.number)).toEqual([1]);
  });
});
