import { describe, expect, test } from "bun:test";
import { mapGhIssueState, parseEpicsList } from "../src/github.ts";

describe("parseEpicsList", () => {
  test("maps sub_issues_summary into Epic rows", () => {
    const ndjson = [
      JSON.stringify({
        number: 247,
        title: "OAuth refresh",
        state: "open",
        labels: [{ name: "epic" }, { name: "agent:claude" }],
        sub_issues_summary: { total: 4, completed: 2 },
      }),
      JSON.stringify({
        number: 9,
        title: "no sub-issues",
        state: "open",
        labels: [],
        sub_issues_summary: { total: 0, completed: 0 },
      }),
    ].join("\n");

    expect(parseEpicsList(ndjson)).toEqual([
      {
        ref: "247",
        number: 247,
        title: "OAuth refresh",
        state: "open",
        labels: ["epic", "agent:claude"],
        subTotal: 4,
        subClosed: 2,
      },
    ]);
  });

  test("tolerates blank lines and ignores rows missing a summary", () => {
    const ndjson = `\n${JSON.stringify({ number: 1, title: "x", state: "open", labels: [] })}\n`;
    expect(parseEpicsList(ndjson)).toEqual([]);
  });

  test("parses with labels: [] when labels key is wholly absent", () => {
    const ndjson = JSON.stringify({
      number: 2,
      title: "y",
      state: "open",
      sub_issues_summary: { total: 1, completed: 0 },
    });
    expect(parseEpicsList(ndjson)).toEqual([
      { ref: "2", number: 2, title: "y", state: "open", labels: [], subTotal: 1, subClosed: 0 },
    ]);
  });
});

describe("mapGhIssueState", () => {
  test("OPEN → open (still-blocking)", () => {
    expect(mapGhIssueState("OPEN", "an issue")).toEqual({ state: "open", title: "an issue" });
  });

  test("CLOSED → closed (resolved → unblock)", () => {
    expect(mapGhIssueState("CLOSED", "done")).toEqual({ state: "closed", title: "done" });
  });

  test("MERGED (a PR ref) → closed (resolved → unblock), not unresolvable", () => {
    expect(mapGhIssueState("MERGED", "a merged pr")).toEqual({
      state: "closed",
      title: "a merged pr",
    });
  });

  test("an unknown/future state → null (stale blocker), never a default unblock", () => {
    // Anything we don't recognize must NOT read as closed (which would silently
    // unblock a dependent Epic) — it's unresolvable.
    expect(mapGhIssueState("DRAFT", "?")).toBeNull();
    expect(mapGhIssueState("LOCKED", "?")).toBeNull();
    expect(mapGhIssueState("", "?")).toBeNull();
    // Casing matters — gh always reports uppercase; a lowercase value is unexpected.
    expect(mapGhIssueState("open", "?")).toBeNull();
  });
});
