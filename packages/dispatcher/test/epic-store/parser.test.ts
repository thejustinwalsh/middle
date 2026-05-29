import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEpicFile } from "../../src/epic-store/epic-file/parser.ts";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "fixtures", `${name}.md`), "utf8");

describe("parseEpicFile — document structure", () => {
  test("parses the document marker, title, and minimal meta from an empty Epic", () => {
    const epic = parseEpicFile(fixture("empty-epic"));
    expect(epic.title).toBe("Untitled Epic");
    expect(epic.meta.slug).toBe("untitled");
    expect(epic.acceptanceCriteria).toEqual([]);
    expect(epic.subIssues).toEqual([]);
    expect(epic.conversation).toEqual([]);
  });

  test("throws when the document marker is missing", () => {
    expect(() => parseEpicFile("# No Marker\n")).toThrow(/document marker/i);
  });

  test("throws when the meta block has no slug key", () => {
    const body = `<!-- middle:epic v1 -->\n# X\n\n<!-- middle:meta\n-->\n\n## Context\n\n## Acceptance criteria\n\n## Sub-issues\n\n<!-- middle:conversation -->\n<!-- /middle:conversation -->\n`;
    expect(() => parseEpicFile(body)).toThrow(/slug/i);
  });
});

describe("parseEpicFile — meta", () => {
  test("parses every recognized meta key from codex-adapter fixture", () => {
    const epic = parseEpicFile(fixture("codex-adapter"));
    expect(epic.meta).toEqual({
      slug: "codex-adapter",
      adapter: "claude",
      complexityCeiling: 3,
      approved: false,
      labels: ["phase:10", "dogfood"],
    });
  });

  test("parses closed=true", () => {
    const epic = parseEpicFile(fixture("all-closed"));
    expect(epic.meta.closed).toBe(true);
  });
});

describe("parseEpicFile — acceptance criteria", () => {
  test("parses unchecked criteria from codex-adapter", () => {
    const epic = parseEpicFile(fixture("codex-adapter"));
    expect(epic.acceptanceCriteria).toHaveLength(3);
    expect(epic.acceptanceCriteria[0]).toEqual({
      checked: false,
      text: "Codex agent dispatches end-to-end against a test issue",
    });
  });

  test("parses checked criteria from all-closed", () => {
    const epic = parseEpicFile(fixture("all-closed"));
    expect(epic.acceptanceCriteria.every((a) => a.checked)).toBe(true);
  });
});

describe("parseEpicFile — sub-issues", () => {
  test("parses sub-issues with stable IDs + body", () => {
    const epic = parseEpicFile(fixture("codex-adapter"));
    expect(epic.subIssues).toHaveLength(3);
    expect(epic.subIssues[0]).toMatchObject({
      id: 1,
      checked: false,
      title: "1 — Implement the CodexAdapter",
    });
    expect(epic.subIssues[0]!.body).toContain("Full AgentAdapter: launch command");
  });

  test("parses checked sub-issues + provenance suffix", () => {
    const epic = parseEpicFile(fixture("all-closed"));
    expect(epic.subIssues).toHaveLength(3);
    expect(epic.subIssues[0]).toMatchObject({
      id: 1,
      checked: true,
      title: "1 — Implement the CodexAdapter",
      provenance: "*(done in wf_oyy4c4m1 sha abc1234)*",
    });
  });
});

describe("parseEpicFile — conversation", () => {
  test("parses dispatch-event + question entries; empty answer block stays absent", () => {
    const epic = parseEpicFile(fixture("mid-question"));
    expect(epic.conversation).toHaveLength(2);
    const [dispatch, question] = epic.conversation;
    expect(dispatch?.kind).toBe("dispatch-event");
    if (dispatch?.kind === "dispatch-event") {
      expect(dispatch.eventKind).toBe("dispatched");
      expect(dispatch.body).toContain("Dispatched workflow `wf_oyy4c4m1`");
    }
    expect(question?.kind).toBe("question");
    if (question?.kind === "question") {
      expect(question.id).toBe(1);
      expect(question.status).toBe("open");
      expect(question.questionKind).toBe("question");
      expect(question.body).toContain("Should I defer the live dual-dispatch criterion");
      expect(question.answer).toBeUndefined();
    }
  });

  test("treats a non-empty answer block as the resolved reply", () => {
    const body = fixture("mid-question").replace(
      "<!-- middle:answer for=1 -->\n<!-- Human edits here. File-watcher fires resume on this section becoming non-empty. -->\n<!-- /middle:answer -->",
      "<!-- middle:answer for=1 -->\nAuthorized: proceed with deferral.\n<!-- /middle:answer -->",
    );
    const epic = parseEpicFile(body);
    const q = epic.conversation[1]!;
    if (q.kind !== "question") throw new Error("expected question entry");
    expect(q.answer).toEqual({ body: "Authorized: proceed with deferral." });
  });

  test("empty conversation block yields empty conversation array", () => {
    const epic = parseEpicFile(fixture("codex-adapter"));
    expect(epic.conversation).toEqual([]);
  });
});
