/**
 * Integration (#212): the deterministic foundation of the live-smoke harness.
 * Drives the **real** `createImplementationWorkflow` (real engine,
 * `createWorktree`, `parseEpicFile`/`renderEpicFile`, the real
 * `makeDefaultPostQuestion`, the real `runFileWatcherTick`) against an in-tmpdir
 * `epic_store="file"` repo through the full loop — dispatch → park-on-question →
 * answer-via-file-edit → resume → complete. The only stub is the gh boundary at
 * `EpicGateway`'s PR/comment methods, which file mode must never touch.
 *
 * This runs on every commit to `main`; the live-GitHub smoke (`--live`, sibling
 * sub-issue) is the opt-in operator counterpart that drives the same loop against
 * real GitHub. The drive itself lives in `runFileModeSmoke` so `mm
 * verify-file-mode` exercises the identical path — this test asserts the deep
 * invariants the command's report can't.
 */

import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { parseEpicFile } from "../../src/epic-store/epic-file/parser.ts";
import { runFileModeSmoke } from "../../src/epic-store/file-mode-smoke.ts";

describe("file-mode live-smoke — real workflow end-to-end (no real GitHub)", () => {
  test("dispatch → park → answer-via-edit → resume → complete, all invariants hold", async () => {
    const result = await runFileModeSmoke();

    // Every section passed and the run is green.
    expect(result.failedSection).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.sections.map((s) => s.name)).toEqual([
      "init",
      "author",
      "dispatch",
      "park",
      "answer",
      "resume",
      "complete",
    ]);
    expect(result.sections.every((s) => s.ok)).toBe(true);

    // The gh boundary was never touched — file mode is fully file-backed.
    expect(result.ghCalls).toEqual([]);

    // The worktree's `<sub-issue id=1>` checkbox flipped to `[x]` (the agent's work),
    // captured before `finalize` tore the worktree down on completion.
    expect(result.worktreePath).not.toBeNull();
    expect(result.worktreeEpic).not.toBeNull();
    const sub1 = result.worktreeEpic!.subIssues.find((s) => s.id === 1);
    expect(sub1?.checked).toBe(true);

    // The repo Epic file's conversation carries exactly one question — answered
    // and resolved — i.e. exactly one `<!-- middle:question -->` + one
    // `<!-- middle:answer -->`, not a duplicated or extra entry.
    const questions = result.conversation.filter((e) => e.kind === "question");
    expect(questions).toHaveLength(1);
    const q = questions[0]!;
    expect(q.kind).toBe("question");
    if (q.kind === "question") {
      expect(q.status).toBe("resolved"); // the watcher flipped it after firing
      expect(q.answer?.body).toBe("Go with A.");
    }
    expect(result.conversation).toHaveLength(1);
    const countOf = (needle: string): number => result.rawEpicText.split(needle).length - 1;
    expect(countOf("<!-- middle:question ")).toBe(1);
    expect(countOf("<!-- middle:answer for=")).toBe(1);

    // The conversation round-trips through the parser (the write survived).
    expect(() => parseEpicFile(result.rawEpicText)).not.toThrow();

    // The fixture's tmpdir was fully cleaned up regardless of outcome.
    expect(result.cleanedUp).toBe(true);
    expect(existsSync(result.scratchDir)).toBe(false);
  });
});
