import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStart } from "../src/commands/start.ts";
import { runStop } from "../src/commands/stop.ts";

let dir: string;
let pidFile: string;
let entrypoint: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "middle-cli-startstop-"));
  pidFile = join(dir, "dispatcher.pid");
  // a stand-in dispatcher: an idle process that simply stays alive
  entrypoint = join(dir, "fake-dispatcher.ts");
  writeFileSync(entrypoint, "await new Promise(() => {});\n");
});

afterEach(() => {
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (Number.isInteger(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(): number {
  return Number(readFileSync(pidFile, "utf8").trim());
}

function silence(): () => void {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation(() => {});
  return () => {
    log.mockRestore();
    err.mockRestore();
  };
}

describe("runStart / runStop lifecycle", () => {
  test("start spawns a detached process and records its pid; stop kills it", async () => {
    const restore = silence();
    try {
      expect(runStart({ pidFile, entrypoint })).toBe(0);
      expect(existsSync(pidFile)).toBe(true);
      const pid = readPid();
      expect(Number.isInteger(pid)).toBe(true);
      await Bun.sleep(150);
      expect(isAlive(pid)).toBe(true);

      expect(runStop({ pidFile })).toBe(0);
      expect(existsSync(pidFile)).toBe(false);
      await Bun.sleep(150);
      expect(isAlive(pid)).toBe(false);
    } finally {
      restore();
    }
  });

  test("start refuses when a live dispatcher is already recorded", async () => {
    const restore = silence();
    try {
      expect(runStart({ pidFile, entrypoint })).toBe(0);
      await Bun.sleep(100);
      expect(runStart({ pidFile, entrypoint })).toBe(1); // already running
      expect(runStop({ pidFile })).toBe(0);
    } finally {
      restore();
    }
  });

  test("start clears a stale pid file and launches fresh", async () => {
    writeFileSync(pidFile, "999999999"); // a pid that is not alive
    const restore = silence();
    try {
      expect(runStart({ pidFile, entrypoint })).toBe(0);
      expect(existsSync(pidFile)).toBe(true);
      expect(readPid()).not.toBe(999999999);
      expect(runStop({ pidFile })).toBe(0);
    } finally {
      restore();
    }
  });

  test("stop exits non-zero when no dispatcher is running", () => {
    const restore = silence();
    try {
      expect(runStop({ pidFile })).toBe(1);
    } finally {
      restore();
    }
  });
});
