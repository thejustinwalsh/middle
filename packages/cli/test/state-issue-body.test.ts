import { describe, expect, test } from "bun:test";
import { isParseError, parseStateIssue, renderStateIssue, validate } from "@middle/state-issue";
import { parseRepoSlug } from "../src/bootstrap/deps.ts";
import { buildInitialStateIssueBody } from "../src/bootstrap/state-issue-body.ts";

describe("buildInitialStateIssueBody", () => {
  const body = buildInitialStateIssueBody(new Date("2026-05-23T12:00:00.000Z"));

  test("parses and validates against the schema (configured adapters)", () => {
    const parsed = parseStateIssue(body);
    expect(isParseError(parsed)).toBe(false);
    if (!isParseError(parsed)) {
      expect(validate(parsed, { adapters: ["claude", "codex"] }).ok).toBe(true);
    }
  });

  test("is empty in every section", () => {
    const parsed = parseStateIssue(body);
    if (isParseError(parsed)) throw new Error("expected a valid body");
    expect(parsed.readyToDispatch).toEqual([]);
    expect(parsed.needsHumanInput).toEqual([]);
    expect(parsed.blocked).toEqual([]);
    expect(parsed.inFlight).toEqual([]);
    expect(parsed.excluded).toEqual([]);
    expect(parsed.slotUsage.adapters).toEqual([]);
  });

  test("round-trips byte-identically (the keystone invariant)", () => {
    const parsed = parseStateIssue(body);
    if (isParseError(parsed)) throw new Error("expected a valid body");
    expect(renderStateIssue(parsed)).toBe(body);
  });

  test("carries the markers and the generated timestamp", () => {
    expect(body).toContain("<!-- AGENT-QUEUE-STATE v1 -->");
    expect(body).toContain("<!-- /AGENT-QUEUE-STATE -->");
    expect(body).toContain("2026-05-23T12:00:00.000Z");
  });
});

describe("parseRepoSlug", () => {
  test.each([
    ["git@github.com:acme/widget.git", "acme", "widget"],
    ["https://github.com/acme/widget.git", "acme", "widget"],
    ["https://github.com/acme/widget", "acme", "widget"],
    ["ssh://git@github.com/acme/widget.git", "acme", "widget"],
    ["https://github.com/acme/widget/", "acme", "widget"],
  ])("parses %s", (url, owner, name) => {
    expect(parseRepoSlug(url)).toEqual({ owner, name });
  });

  test("returns null for an unparseable URL", () => {
    expect(parseRepoSlug("not-a-url")).toBeNull();
  });
});
