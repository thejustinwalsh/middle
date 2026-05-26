import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addMiddleIgnore, removeMiddleIgnore } from "../src/bootstrap/gitignore.ts";

let repo: string;
let path: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "mm-gitignore-"));
  path = join(repo, ".gitignore");
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("addMiddleIgnore", () => {
  test("writes the glob form with policy/verify exceptions into a new file", async () => {
    expect(await addMiddleIgnore(repo)).toBe(true);
    const gi = readFileSync(path, "utf8");
    expect(gi).toContain(".middle/*");
    expect(gi).toContain("!.middle/policy.toml");
    expect(gi).toContain("!.middle/verify.toml");
    // the bare directory form must NOT be present — it would defeat the `!` lines
    expect(gi.split("\n")).not.toContain(".middle/");
  });

  test("preserves existing unrelated entries", async () => {
    writeFileSync(path, "node_modules/\n*.log\n");
    await addMiddleIgnore(repo);
    const gi = readFileSync(path, "utf8");
    expect(gi).toContain("node_modules/");
    expect(gi).toContain("*.log");
    expect(gi).toContain(".middle/*");
  });

  test("is idempotent — a second call makes no change", async () => {
    await addMiddleIgnore(repo);
    const first = readFileSync(path, "utf8");
    expect(await addMiddleIgnore(repo)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(first);
  });

  test("upgrades a legacy bare `.middle/` entry to the glob form", async () => {
    writeFileSync(path, "node_modules/\n.middle/\n");
    expect(await addMiddleIgnore(repo)).toBe(true);
    const lines = readFileSync(path, "utf8").split("\n");
    expect(lines).not.toContain(".middle/"); // legacy line removed
    expect(lines).toContain(".middle/*");
    expect(lines).toContain("!.middle/policy.toml");
    expect(readFileSync(path, "utf8")).toContain("node_modules/");
  });
});

describe("removeMiddleIgnore", () => {
  test("strips the whole block, leaving other entries", async () => {
    writeFileSync(path, "node_modules/\n");
    await addMiddleIgnore(repo);
    expect(await removeMiddleIgnore(repo)).toBe(true);
    const gi = readFileSync(path, "utf8");
    expect(gi).toContain("node_modules/");
    expect(gi).not.toContain(".middle/"); // covers .middle/*, !.middle/policy.toml, etc.
  });

  test("deletes the file when it empties", async () => {
    await addMiddleIgnore(repo);
    await removeMiddleIgnore(repo);
    expect(existsSync(path)).toBe(false);
  });

  test("also clears a legacy bare `.middle/` line", async () => {
    writeFileSync(path, "node_modules/\n.middle/\n");
    expect(await removeMiddleIgnore(repo)).toBe(true);
    const gi = readFileSync(path, "utf8");
    expect(gi).toContain("node_modules/");
    expect(gi.split("\n")).not.toContain(".middle/");
  });

  test("no-op when there's nothing middle-owned to remove", async () => {
    writeFileSync(path, "node_modules/\n");
    expect(await removeMiddleIgnore(repo)).toBe(false);
  });

  test("no file at all is a no-op", async () => {
    expect(await removeMiddleIgnore(repo)).toBe(false);
  });
});
