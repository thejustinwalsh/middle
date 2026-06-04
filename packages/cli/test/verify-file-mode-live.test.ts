/**
 * Plumbing (#214): the `mm verify-file-mode --live` orchestration, driven against
 * an injected fake {@link LiveSmokeIO}. The real-GitHub *evidence run* is the
 * operator step the Epic acknowledges a headless run can't perform (it needs a
 * real repo + a real agent); this proves the control flow deterministically —
 * arg validation, the park → answer → resume detour, the draft-PR + checkbox
 * assertions, cleanup-on-success, and leave-artifacts-on-failure.
 */

import { describe, expect, test } from "bun:test";
import {
  runLiveSmoke,
  runVerifyFileModeLive,
  type LivePr,
  type LiveSmokeIO,
  type SettledState,
} from "../src/commands/verify-file-mode-live.ts";

type Trace = { calls: string[]; lines: string[] };

/** Scripted return values; every base method still records its call into the trace. */
type Script = {
  settled?: SettledState;
  pr?: LivePr | null;
  checked?: boolean;
};

/** Build a fake IO + a trace from scripted return values (so recording is never lost). */
function fakeIO(script: Script = {}): { io: LiveSmokeIO; trace: Trace } {
  const trace: Trace = { calls: [], lines: [] };
  const defaultPr: LivePr = { number: 42, isDraft: true, url: "https://github.com/o/r/pull/42" };
  const pr = script.pr === undefined ? defaultPr : script.pr;
  const io: LiveSmokeIO = {
    log: (l) => trace.lines.push(l),
    authorEpic: async () => {
      trace.calls.push("authorEpic");
      return {
        slug: "verify-smoke-1",
        branch: "middle-smoke-1",
        branchUrl: "https://github.com/o/r/tree/middle-smoke-1",
      };
    },
    dispatch: async () => {
      trace.calls.push("dispatch");
      return script.settled ?? "completed";
    },
    answerQuestion: async () => {
      trace.calls.push("answerQuestion");
    },
    awaitResume: async () => {
      trace.calls.push("awaitResume");
    },
    findEpicPr: async () => {
      trace.calls.push("findEpicPr");
      return pr;
    },
    isSubIssueChecked: async () => {
      trace.calls.push("isSubIssueChecked");
      return script.checked ?? true;
    },
    cleanup: async () => {
      trace.calls.push("cleanup");
    },
  };
  return { io, trace };
}

describe("runLiveSmoke orchestration", () => {
  test("happy path with no park → asserts PR + checkbox, cleans up, exit 0", async () => {
    const { io, trace } = fakeIO();
    const code = await runLiveSmoke(io);
    expect(code).toBe(0);
    // No park → no answer/resume detour.
    expect(trace.calls).toEqual([
      "authorEpic",
      "dispatch",
      "findEpicPr",
      "isSubIssueChecked",
      "cleanup",
    ]);
    expect(trace.lines.at(-1)).toBe("cleaned up the test branch + PR.");
  });

  test("park path → answers, awaits resume, then asserts + cleans up, exit 0", async () => {
    const { io, trace } = fakeIO({ settled: "waiting-human" });
    const code = await runLiveSmoke(io);
    expect(code).toBe(0);
    expect(trace.calls).toEqual([
      "authorEpic",
      "dispatch",
      "answerQuestion",
      "awaitResume",
      "findEpicPr",
      "isSubIssueChecked",
      "cleanup",
    ]);
  });

  test("dispatch failed → leaves the branch, exit 1, no PR checks", async () => {
    const { io, trace } = fakeIO({ settled: "failed" });
    const code = await runLiveSmoke(io);
    expect(code).toBe(1);
    expect(trace.calls).toEqual(["authorEpic", "dispatch"]);
    expect(trace.calls).not.toContain("cleanup");
    expect(trace.lines.at(-1)).toContain("tree/middle-smoke-1");
  });

  test("no draft PR → leaves the branch URL, exit 1, no cleanup", async () => {
    const { io, trace } = fakeIO({ pr: null });
    const code = await runLiveSmoke(io);
    expect(code).toBe(1);
    expect(trace.calls).not.toContain("cleanup");
    expect(trace.lines.at(-1)).toContain("no draft PR");
  });

  test("PR exists but not a draft → leaves the PR URL, exit 1, no cleanup", async () => {
    const { io, trace } = fakeIO({
      pr: { number: 7, isDraft: false, url: "https://github.com/o/r/pull/7" },
    });
    const code = await runLiveSmoke(io);
    expect(code).toBe(1);
    expect(trace.calls).not.toContain("cleanup");
    expect(trace.lines.at(-1)).toContain("pull/7");
  });

  test("checkbox not flipped → leaves the PR for inspection, exit 1, no cleanup", async () => {
    const { io, trace } = fakeIO({ checked: false });
    const code = await runLiveSmoke(io);
    expect(code).toBe(1);
    expect(trace.calls).not.toContain("cleanup");
    expect(trace.lines.at(-1)).toContain("checkbox not flipped");
  });
});

describe("runVerifyFileModeLive arg validation", () => {
  test("rejects a missing --repo", async () => {
    expect(await runVerifyFileModeLive({})).toBe(1);
  });

  test("rejects a non-owner/name --repo", async () => {
    expect(await runVerifyFileModeLive({ repo: "not-a-slug" })).toBe(1);
  });

  test("accepts owner/name and runs the injected IO", async () => {
    const { io, trace } = fakeIO();
    const code = await runVerifyFileModeLive({ repo: "o/r", io });
    expect(code).toBe(0);
    expect(trace.calls[0]).toBe("authorEpic");
  });
});
