import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDispatch } from "../src/commands/dispatch.ts";

// The full `mm dispatch` happy path spawns a real Claude session in tmux and is
// verified manually (see the reviewer's brief). These tests cover the input
// validation that fails fast, before any process is spawned.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "middle-cli-dispatch-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function silenceError(): () => void {
  const err = spyOn(console, "error").mockImplementation(() => {});
  return () => err.mockRestore();
}

describe("runDispatch — input validation", () => {
  test("rejects a non-integer epic number", async () => {
    const restore = silenceError();
    try {
      expect(await runDispatch(dir, "not-a-number")).toBe(1);
    } finally {
      restore();
    }
  });

  test("rejects an epic number below 1", async () => {
    const restore = silenceError();
    try {
      expect(await runDispatch(dir, "0")).toBe(1);
    } finally {
      restore();
    }
  });

  test("rejects a path that is not a git repository", async () => {
    const restore = silenceError();
    try {
      expect(await runDispatch(dir, "6")).toBe(1);
    } finally {
      restore();
    }
  });
});
