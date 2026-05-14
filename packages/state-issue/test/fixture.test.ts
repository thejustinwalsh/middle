import { describe, expect, test } from "bun:test";
import type { RepoConfig } from "@middle/core";
import { isParseError, parseStateIssue } from "../src/parser.ts";
import { renderStateIssue } from "../src/renderer.ts";
import type { ParsedState } from "../src/schema.v1.ts";
import { validate } from "../src/validate.ts";

const FIXTURE_PATH = new URL("./fixtures/state-issue.example.md", import.meta.url);
const config: RepoConfig = { adapters: ["claude", "codex"] };

const fixture = await Bun.file(FIXTURE_PATH).text();
const parsed = parseStateIssue(fixture);

describe("hand-crafted state-issue fixture", () => {
  test("parseStateIssue succeeds", () => {
    expect(isParseError(parsed)).toBe(false);
  });

  test("validate returns pass", () => {
    expect(validate(parsed as ParsedState, config)).toEqual({ ok: true });
  });

  test("round-trips byte-identically", () => {
    expect(renderStateIssue(parsed as ParsedState)).toBe(fixture);
  });

  test("exercises all seven sections with non-empty content", () => {
    const state = parsed as ParsedState;
    expect(state.readyToDispatch.length).toBeGreaterThan(0);
    expect(state.needsHumanInput.length).toBeGreaterThan(0);
    expect(state.blocked.length).toBeGreaterThan(0);
    expect(state.inFlight.length).toBeGreaterThan(0);
    expect(state.excluded.length).toBeGreaterThan(0);
    expect(state.rateLimits.claude).not.toBe("");
    expect(state.rateLimits.codex).not.toBe("");
    expect(state.rateLimits.github).not.toBe("");
    expect(state.slotUsage.adapters.length).toBeGreaterThan(0);
    // Blocked exercises both an issue-ref blocker and a non-issue blocker.
    expect(state.blocked.some((b) => b.blocker.startsWith("#"))).toBe(true);
    expect(state.blocked.some((b) => b.blocker.startsWith("`"))).toBe(true);
  });
});
