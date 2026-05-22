import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAndMigrate } from "@middle/dispatcher/src/db.ts";
import { createWorkflowRecord, updateWorkflow } from "@middle/dispatcher/src/workflow-record.ts";
import { runStatus } from "../src/commands/status.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "middle-cli-status-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Capture everything written to console.log while running `fn`. */
function captureLog(fn: () => number): { code: number; lines: string[] } {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  try {
    return { code: fn(), lines };
  } finally {
    spy.mockRestore();
  }
}

function writeConfig(dbPath: string): string {
  const path = join(dir, "config.toml");
  writeFileSync(path, `[global]\ndb_path = "${dbPath}"\n`);
  return path;
}

describe("runStatus", () => {
  test("prints a per-repo, per-state summary of recorded workflows", () => {
    const dbPath = join(dir, "db.sqlite3");
    const db = openAndMigrate(dbPath);
    createWorkflowRecord(db, {
      id: "w1",
      kind: "implementation",
      repo: "thejustinwalsh/middle",
      epicNumber: 6,
      adapter: "claude",
    });
    createWorkflowRecord(db, {
      id: "w2",
      kind: "implementation",
      repo: "thejustinwalsh/middle",
      epicNumber: 7,
      adapter: "claude",
    });
    updateWorkflow(db, "w2", { state: "completed" });
    db.close();

    const { code, lines } = captureLog(() => runStatus({ configPath: writeConfig(dbPath) }));
    expect(code).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain("thejustinwalsh/middle");
    expect(output).toContain("pending");
    expect(output).toContain("completed");
  });

  test("reports cleanly when the database does not exist yet", () => {
    const { code, lines } = captureLog(() =>
      runStatus({ configPath: writeConfig(join(dir, "absent.sqlite3")) }),
    );
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("no dispatcher database");
  });

  test("reports cleanly when the database has no workflows", () => {
    const dbPath = join(dir, "empty.sqlite3");
    openAndMigrate(dbPath).close();
    const { code, lines } = captureLog(() => runStatus({ configPath: writeConfig(dbPath) }));
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("no workflows recorded");
  });

  test("exits non-zero when the config file is malformed", () => {
    const badConfig = join(dir, "bad.toml");
    writeFileSync(badConfig, "this is = = not valid toml ][");
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(runStatus({ configPath: badConfig })).toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});
