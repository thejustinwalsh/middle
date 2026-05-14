import { describe, expect, test } from "bun:test";
import type { RepoConfig } from "@middle/core";
import { validate } from "../src/validate.ts";
import { fullState } from "./sample-states.ts";

const config: RepoConfig = { adapters: ["claude", "codex"] };

describe("validate", () => {
  test("passes a schema-conforming state", () => {
    expect(validate(fullState, config)).toEqual({ ok: true });
  });

  test("fails when a Ready row uses an unconfigured adapter", () => {
    const bad = {
      ...fullState,
      readyToDispatch: [
        { rank: 1, epic: "#1 thing", adapter: "gemini", subIssues: 1, reason: "x" },
      ],
    };
    const result = validate(bad, config);
    expect(result.ok).toBe(false);
  });

  test("fails when an In-flight item uses an unconfigured adapter", () => {
    const bad = {
      ...fullState,
      inFlight: [
        {
          issue: 1,
          adapter: "gemini",
          progress: "running",
          lastHeartbeat: "1m ago",
          tmuxSession: "middle-1",
        },
      ],
    };
    expect(validate(bad, config).ok).toBe(false);
  });

  test("fails when generated is not ISO 8601", () => {
    expect(validate({ ...fullState, generated: "not-a-date" }, config).ok).toBe(false);
  });

  test("fails when an epic reference is malformed", () => {
    const bad = {
      ...fullState,
      readyToDispatch: [
        { rank: 1, epic: "42 missing hash", adapter: "claude", subIssues: 1, reason: "x" },
      ],
    };
    expect(validate(bad, config).ok).toBe(false);
  });

  test("fails when a Ready row epic has no title", () => {
    const bad = {
      ...fullState,
      readyToDispatch: [
        { rank: 1, epic: "#42", adapter: "claude", subIssues: 1, reason: "x" },
      ],
    };
    expect(validate(bad, config).ok).toBe(false);
  });

  test("fails when a blocked issue-blocker reference is malformed", () => {
    const bad = {
      ...fullState,
      blocked: [{ issue: 9, blocker: "#notanumber", context: "x" }],
    };
    expect(validate(bad, config).ok).toBe(false);
  });

  test("accepts a non-issue blocker in backticks", () => {
    const ok = {
      ...fullState,
      blocked: [{ issue: 9, blocker: "`upstream release`", context: "x" }],
    };
    expect(validate(ok, config).ok).toBe(true);
  });

  test("collects multiple errors", () => {
    const bad = {
      ...fullState,
      generated: "nope",
      readyToDispatch: [
        { rank: 1, epic: "#1 x", adapter: "gemini", subIssues: 1, reason: "x" },
      ],
    };
    const result = validate(bad, config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});
