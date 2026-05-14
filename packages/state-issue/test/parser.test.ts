import { describe, expect, test } from "bun:test";
import { isParseError, parseStateIssue } from "../src/parser.ts";
import { renderStateIssue } from "../src/renderer.ts";
import type { ParsedState } from "../src/schema.v1.ts";
import { emptyState, fullState } from "./sample-states.ts";

describe("renderStateIssue", () => {
  test("renders an empty state in canonical form", () => {
    const body = renderStateIssue(emptyState);
    expect(body).toBe(
      [
        "<!-- AGENT-QUEUE-STATE v1 -->",
        "<!-- generated: 2026-05-14T12:00:00Z · run: a1b2c3d4 · interval: 15m -->",
        "<!-- owners: recommender=full-body, dispatcher=in-flight,rate-limits,slot-usage -->",
        "",
        "## Ready to dispatch",
        "",
        "| Rank | Epic | Adapter | Sub-issues | Reason |",
        "| --- | --- | --- | --- | --- |",
        "| — | _no Epics ready_ | — | — | — |",
        "",
        "## Needs human input",
        "",
        "## Blocked",
        "",
        "## In-flight",
        "",
        "- _no agents in flight_",
        "",
        "## Excluded",
        "",
        "## Rate limits",
        "",
        "- claude: AVAILABLE",
        "- codex: AVAILABLE",
        "- github: 5000/5000 req/hr · resets in 60m",
        "",
        "## Slot usage",
        "",
        "- total: 0/0",
        "- global: 0/0",
        "",
        "<!-- /AGENT-QUEUE-STATE -->",
      ].join("\n"),
    );
  });

  test("renders a fully-populated state with all section content", () => {
    const body = renderStateIssue(fullState);
    expect(body).toContain("| 1 | #42 Recommender workflow | claude | 6 | `unblocks dogfooding` |");
    expect(body).toContain(
      "- **#7 ready for review** — PR open, all phases verified · [link](https://example.com/issues/7)",
    );
    expect(body).toContain("- **#9** waiting on #42 · needs the recommender first");
    expect(body).toContain(
      "- **#54** · claude · sub-issue 2/5 · last heartbeat 30s ago · [tmux: middle-54]",
    );
    expect(body).toContain("- **#3** assigned to human — being handled manually");
    expect(body).toContain("- claude: 1/2");
    expect(body).toContain("- total: 1/3");
    expect(body).toContain("- global: 1/4");
  });
});

describe("parseStateIssue", () => {
  test("parses the canonical empty body back to the original state", () => {
    const parsed = parseStateIssue(renderStateIssue(emptyState));
    expect(isParseError(parsed)).toBe(false);
    expect(parsed).toEqual(emptyState);
  });

  test("parses a fully-populated body back to the original state", () => {
    const parsed = parseStateIssue(renderStateIssue(fullState));
    expect(isParseError(parsed)).toBe(false);
    expect(parsed).toEqual(fullState);
  });

  test("returns ParseError when the open marker is missing", () => {
    const body = renderStateIssue(emptyState).replace("<!-- AGENT-QUEUE-STATE v1 -->\n", "");
    expect(isParseError(parseStateIssue(body))).toBe(true);
  });

  test("returns ParseError when the close marker is missing", () => {
    const body = renderStateIssue(emptyState).replace("\n<!-- /AGENT-QUEUE-STATE -->", "");
    expect(isParseError(parseStateIssue(body))).toBe(true);
  });

  test("returns ParseError when a section is out of order", () => {
    const body = renderStateIssue(emptyState).replace("## Blocked", "## Excluded");
    expect(isParseError(parseStateIssue(body))).toBe(true);
  });

  test("ignores content outside the markers", () => {
    const inner = renderStateIssue(fullState);
    const wrapped = `# Some heading\n\nGitHub added this.\n\n${inner}\n\ntrailing junk\n`;
    expect(parseStateIssue(wrapped)).toEqual(fullState);
  });

  test("ignores dispatcher-tick markers between sections", () => {
    const body = renderStateIssue(fullState).replace(
      "## Blocked",
      "<!-- dispatcher-tick: 2026-05-14T12:05:00Z -->\n## Blocked",
    );
    expect(parseStateIssue(body)).toEqual(fullState);
  });
});

describe("round-trip", () => {
  test("render(parse(render(state))) is byte-identical to render(state)", () => {
    for (const state of [emptyState, fullState]) {
      const once = renderStateIssue(state);
      const parsed = parseStateIssue(once);
      expect(isParseError(parsed)).toBe(false);
      expect(renderStateIssue(parsed as ParsedState)).toBe(once);
    }
  });
});
