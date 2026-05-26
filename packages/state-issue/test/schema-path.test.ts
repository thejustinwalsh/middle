import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { STATE_ISSUE_SCHEMA_PATH } from "../src/schema-path.ts";

describe("STATE_ISSUE_SCHEMA_PATH", () => {
  test("is an absolute path ending in the canonical schema filename", () => {
    expect(isAbsolute(STATE_ISSUE_SCHEMA_PATH)).toBe(true);
    // Separator-agnostic so the assertion holds on any platform.
    expect(STATE_ISSUE_SCHEMA_PATH.endsWith(join("schemas", "state-issue.v1.md"))).toBe(true);
  });

  test("points at the real schema shipped in the middle install (not a target repo)", () => {
    // Resolution is from import.meta.dir, so this holds regardless of cwd. The
    // file must exist — a miss means a broken middle checkout, not a repo problem.
    expect(existsSync(STATE_ISSUE_SCHEMA_PATH)).toBe(true);
    const body = readFileSync(STATE_ISSUE_SCHEMA_PATH, "utf8");
    expect(body).toContain("State Issue — Schema v1");
  });
});
