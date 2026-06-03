import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectChangedSince,
  pollFileSignals,
  resolveQuestion,
} from "../../src/epic-store/watcher.ts";
import { readEpicFile } from "../../src/epic-store/epic-file-io.ts";
import { renderEpicFile } from "../../src/epic-store/epic-file/renderer.ts";
import type { ConversationEntry, EpicFile } from "../../src/epic-store/epic-file/types.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "middle-watch-"));
}

function writeEpic(dir: string, slug: string, conversation: ConversationEntry[]): void {
  const epic: EpicFile = {
    title: "feat: x",
    meta: { slug },
    context: "ctx",
    acceptanceCriteria: [],
    subIssues: [],
    conversation,
  };
  writeFileSync(join(dir, `${slug}.md`), renderEpicFile(epic));
}

const Q_OPEN_ANSWERED: ConversationEntry = {
  kind: "question",
  id: 1,
  status: "open",
  ts: "2026-06-03T00:00:00.000Z",
  body: "A or B?",
  answer: { body: "Go with A." },
};
const Q_OPEN_UNANSWERED: ConversationEntry = {
  kind: "question",
  id: 1,
  status: "open",
  ts: "2026-06-03T00:00:00.000Z",
  body: "A or B?",
};

describe("collectChangedSince", () => {
  test("includes files with mtime > sinceMs, excludes older + dotfiles/.tmp", () => {
    const dir = tmpDir();
    writeEpic(dir, "rollout", []);
    writeFileSync(join(dir, ".keep"), "");
    writeFileSync(join(dir, ".rollout.md.tmp"), "x");
    const mt = statSync(join(dir, "rollout.md")).mtimeMs;
    expect(collectChangedSince(dir, mt - 1)).toEqual(["rollout"]);
    expect(collectChangedSince(dir, mt + 1000)).toEqual([]);
  });

  test("missing dir → empty", () => {
    expect(collectChangedSince(join(tmpDir(), "nope"), 0)).toEqual([]);
  });
});

describe("pollFileSignals", () => {
  test("emits an open question that has a non-empty answer", () => {
    const dir = tmpDir();
    writeEpic(dir, "rollout", [Q_OPEN_ANSWERED]);
    expect(pollFileSignals(dir, 0)).toEqual([
      { ref: "rollout", questionId: 1, body: "Go with A." },
    ]);
  });

  test("an unanswered question (placeholder) does NOT trigger", () => {
    const dir = tmpDir();
    writeEpic(dir, "rollout", [Q_OPEN_UNANSWERED]);
    // The renderer writes the answer placeholder; the parser reads answer=undefined.
    expect(readEpicFile(dir, "rollout")!.conversation[0]).toMatchObject({ answer: undefined });
    expect(pollFileSignals(dir, 0)).toEqual([]);
  });

  test("a resolved question does NOT trigger (only the first non-empty edit fires)", () => {
    const dir = tmpDir();
    writeEpic(dir, "rollout", [{ ...Q_OPEN_ANSWERED, status: "resolved" }]);
    expect(pollFileSignals(dir, 0)).toEqual([]);
  });

  test("the mtime gate skips unchanged files", () => {
    const dir = tmpDir();
    writeEpic(dir, "rollout", [Q_OPEN_ANSWERED]);
    const mt = statSync(join(dir, "rollout.md")).mtimeMs;
    expect(pollFileSignals(dir, mt + 1000)).toEqual([]); // not changed since → skipped
  });
});

describe("resolveQuestion", () => {
  test("flips an open question to resolved (the dedup write); idempotent", () => {
    const dir = tmpDir();
    writeEpic(dir, "rollout", [Q_OPEN_ANSWERED]);
    resolveQuestion(dir, "rollout", 1);
    const after = readEpicFile(dir, "rollout")!;
    expect(after.conversation[0]).toMatchObject({ kind: "question", status: "resolved" });
    // After resolving, the watcher no longer emits it.
    expect(pollFileSignals(dir, 0)).toEqual([]);
    // Idempotent: a second resolve is a no-op (no throw).
    resolveQuestion(dir, "rollout", 1);
    expect(readEpicFile(dir, "rollout")!.conversation[0]).toMatchObject({ status: "resolved" });
  });

  test("a missing file/question is a no-op", () => {
    const dir = tmpDir();
    expect(() => resolveQuestion(dir, "nope", 1)).not.toThrow();
  });
});
