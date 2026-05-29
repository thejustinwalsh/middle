import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  checkStateIssue,
  checkStateIssueRoundTrip,
  STATE_ISSUE_FIXTURE_PATH,
} from "../src/checks/state-issue.ts";

const FIXTURE = readFileSync(STATE_ISSUE_FIXTURE_PATH, "utf8");
const ADAPTERS = ["claude", "codex"];

describe("checkStateIssueRoundTrip", () => {
  test("passes for the canonical conforming fixture", () => {
    const result = checkStateIssueRoundTrip(FIXTURE, ADAPTERS);
    expect(result.ok).toBe(true);
  });

  test("fails when the body does not parse", () => {
    const result = checkStateIssueRoundTrip("not a state issue at all", ADAPTERS);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("parse failed");
  });

  // The byte-identical render(parse(body)) === body invariant itself is owned and
  // exhaustively tested by packages/state-issue (fixture.test.ts); here we cover
  // the parse-fail and validate-fail branches of the doctor wrapper.

  test("fails validate when a Ready row uses an unconfigured adapter", () => {
    // The fixture's Ready rows use claude + codex; drop codex from the config.
    const result = checkStateIssueRoundTrip(FIXTURE, ["claude"]);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("validate failed");
  });
});

describe("checkStateIssue", () => {
  test("passes against middle's own source tree", () => {
    expect(checkStateIssue().status).toBe("pass");
  });
});
