import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAndMigrate } from "@middle/dispatcher/src/db.ts";
import { getPausedUntil, isPaused } from "@middle/dispatcher/src/repo-config.ts";
import { runPause, runResume } from "../src/commands/pause.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "middle-cli-pause-"));
  // The commands require a `.git` dir to accept the path as a repo.
  mkdirSync(join(dir, ".git"), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function captureLog(fn: () => Promise<number>): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...a: unknown[]) =>
    lines.push(a.join(" ")),
  );
  const err = spyOn(console, "error").mockImplementation((...a: unknown[]) =>
    lines.push(a.join(" ")),
  );
  return fn()
    .then((code) => ({ code, lines }))
    .finally(() => {
      log.mockRestore();
      err.mockRestore();
    });
}

describe("mm pause / mm resume", () => {
  test("pause sets paused_until; resume clears it (keyed by the resolved slug)", async () => {
    const dbPath = join(dir, "db.sqlite3");
    const resolveSlug = async () => "o/r";

    const paused = await captureLog(() => runPause(dir, { dbPath, resolveSlug }));
    expect(paused.code).toBe(0);

    const db = openAndMigrate(dbPath);
    try {
      expect(isPaused(db, "o/r")).toBe(true);
    } finally {
      db.close();
    }

    const resumed = await captureLog(() => runResume(dir, { dbPath, resolveSlug }));
    expect(resumed.code).toBe(0);
    const db2 = openAndMigrate(dbPath);
    try {
      expect(getPausedUntil(db2, "o/r")).toBeNull();
      expect(isPaused(db2, "o/r")).toBe(false);
    } finally {
      db2.close();
    }
  });

  test("a slug-resolution failure returns exit 1, not an unhandled rejection", async () => {
    const dbPath = join(dir, "db.sqlite3");
    const boom = async () => {
      throw new Error("git remote unreadable");
    };
    // `resolve()` runs inside the try, so a throw there surfaces as exit 1 with a
    // logged message — for both commands — rather than rejecting the promise.
    const paused = await captureLog(() => runPause(dir, { dbPath, resolveSlug: boom }));
    expect(paused.code).toBe(1);
    expect(paused.lines.join("\n")).toContain("git remote unreadable");

    const resumed = await captureLog(() => runResume(dir, { dbPath, resolveSlug: boom }));
    expect(resumed.code).toBe(1);
    expect(resumed.lines.join("\n")).toContain("git remote unreadable");
  });

  test("a non-git path is rejected with exit 1", async () => {
    const notRepo = mkdtempSync(join(tmpdir(), "middle-cli-notrepo-"));
    try {
      const r = await captureLog(() => runPause(notRepo, { dbPath: join(dir, "db.sqlite3") }));
      expect(r.code).toBe(1);
      expect(r.lines.join("\n")).toContain("not a git repository");
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });
});
