import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNormalizedEvent } from "@middle/core";
import type { HookPayload } from "@middle/core";
import { getAdapter, isKnownAdapter, knownAdapters } from "../src/adapters.ts";

// The proof that the `AgentAdapter` abstraction holds across ALL THREE adapters
// (claude, codex, copilot): the SAME sequence of interface calls is driven against
// every registered adapter through the SAME registry the dispatch workflow uses
// (`getAdapter`), asserting each conforms — and that the adapter-agnostic parts
// (stop classification of the universal `.middle/` sentinels) behave identically.
// A divergence here is a leak in the abstraction, the exact failure mode #124's
// verification (#127) guards. Adding copilot was a one-line registry change here;
// `describe.each(knownAdapters())` picked it up automatically — itself evidence the
// abstraction generalizes. The one seam copilot strained (no per-turn stop hook →
// `sessionEnd` mapped to `agent.stopped`) is documented in
// `planning/issues/124/abstraction-notes.md`; it needed no `AgentAdapter` change.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "middle-conformance-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function worktreeWithMiddle(): { worktree: string; middle: string } {
  const worktree = join(dir, "wt");
  const middle = join(worktree, ".middle");
  mkdirSync(middle, { recursive: true });
  return { worktree, middle };
}

test("the registry knows all three adapters", () => {
  expect(knownAdapters().sort()).toEqual(["claude", "codex", "copilot"]);
});

// Regression: a plain-object registry would inherit `Object.prototype` keys
// (`toString`, `constructor`, `hasOwnProperty`, …) and `getAdapter("toString")`
// would return the inherited function instead of throwing. Lookups must be
// exact-key — the registry is a `Map` for this reason.
describe("registry lookup is exact-key (no prototype walk)", () => {
  for (const protoKey of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
    test(`getAdapter(${JSON.stringify(protoKey)}) throws unknown-adapter`, () => {
      expect(() => getAdapter(protoKey)).toThrow(/unknown adapter/);
    });
    test(`isKnownAdapter(${JSON.stringify(protoKey)}) is false`, () => {
      expect(isKnownAdapter(protoKey)).toBe(false);
    });
  }
});

// Each adapter's ready (`session.started`) payload has a DIFFERENT shape — Claude
// and Codex hand over a `transcript_path`; Copilot carries only `sessionId` + `cwd`
// and the adapter *derives* the path. The conformance point is that
// `resolveTranscriptPath` is satisfiable for every adapter from its own natural
// payload, so the dispatcher never learns the difference. Adding a 4th adapter
// means adding one row here.
const READY_PAYLOADS: Record<string, HookPayload> = {
  claude: { session_id: "s1", transcript_path: "/home/u/.claude/projects/x/s1.jsonl" },
  codex: {
    session_id: "s1",
    transcript_path: "/home/u/.codex/sessions/2026/06/03/rollout-s1.jsonl",
  },
  copilot: { sessionId: "s1", cwd: "/home/u/wt", source: "new" },
};

describe.each(knownAdapters())("AgentAdapter contract — %s", (name) => {
  const adapter = getAdapter(name);

  test("resolveTranscriptPath yields a path from this adapter's own ready payload", () => {
    const payload = READY_PAYLOADS[name];
    expect(payload).toBeDefined(); // a new adapter must add its ready-payload fixture
    const path = adapter.resolveTranscriptPath(payload!);
    expect(typeof path).toBe("string");
    expect(path.length).toBeGreaterThan(0);
  });

  test("identity: name matches its registry key and readyEvent is a normalized event", () => {
    expect(adapter.name).toBe(name);
    expect(isNormalizedEvent(adapter.readyEvent)).toBe(true);
  });

  test("buildLaunchCommand yields a non-empty argv and the session env", () => {
    const { argv, env } = adapter.buildLaunchCommand({
      worktree: dir,
      sessionName: "middle-60",
      sessionToken: "tok",
      envOverrides: { MIDDLE_EPIC: "60" },
    });
    expect(argv.length).toBeGreaterThan(0);
    expect(argv).not.toContain("-p"); // never headless (claude)
    expect(argv).not.toContain("exec"); // never headless (codex)
    expect(env.MIDDLE_SESSION).toBe("middle-60");
    expect(env.MIDDLE_SESSION_TOKEN).toBe("tok");
    expect(env.MIDDLE_EPIC).toBe("60");
  });

  test("buildPromptText: initial is the skill slash-command on the Epic", () => {
    expect(
      adapter.buildPromptText({ promptFile: ".middle/prompt.md", kind: "initial", epicRef: "60" }),
    ).toBe("/implementing-github-issues implement #60");
  });

  test("buildPromptText: recommender / docs force-invoke their skill with the @-ref", () => {
    expect(adapter.buildPromptText({ promptFile: ".middle/prompt.md", kind: "recommender" })).toBe(
      "/recommending-github-issues @.middle/prompt.md",
    );
    expect(adapter.buildPromptText({ promptFile: ".middle/prompt.md", kind: "docs" })).toBe(
      "/documenting-the-repo @.middle/prompt.md",
    );
  });

  test("installHooks writes the shared hook.sh + pr-ready-gate.sh into the worktree", async () => {
    const { worktree } = worktreeWithMiddle();
    await adapter.installHooks({
      worktree,
      hookScriptPath: ".middle/hooks/hook.sh",
      dispatcherUrl: "http://127.0.0.1:4120",
      sessionName: "middle-60",
      sessionToken: "tok",
      epicRef: "60",
    });
    const hook = await Bun.file(join(worktree, ".middle/hooks/hook.sh")).text();
    expect(hook).toStartWith("#!/bin/sh");
    const gate = await Bun.file(join(worktree, ".middle/hooks/pr-ready-gate.sh")).text();
    expect(gate).toContain("/gates/pr-ready");
  });

  // The sentinel resolution in classifyStop is adapter-agnostic (the `.middle/`
  // files are written by the universal skill), so it MUST behave identically
  // across adapters. These assertions run against every adapter and must match.
  test("classifyStop: blocked.json → asked-question", () => {
    const { worktree, middle } = worktreeWithMiddle();
    writeFileSync(join(middle, "blocked.json"), JSON.stringify({ question: "Q?" }));
    const r = adapter.classifyStop({
      payload: { cwd: worktree },
      transcriptPath: join(dir, "missing.jsonl"),
      sentinelPresent: true,
      worktree,
    });
    expect(r.kind).toBe("asked-question");
  });

  test("classifyStop: done.json → done; failed.json → failed; neither → bare-stop", () => {
    const { worktree, middle } = worktreeWithMiddle();
    const transcriptPath = join(dir, "empty.jsonl");
    writeFileSync(transcriptPath, "");

    expect(
      adapter.classifyStop({ payload: {}, transcriptPath, sentinelPresent: false, worktree }).kind,
    ).toBe("bare-stop");

    writeFileSync(join(middle, "done.json"), "{}");
    expect(
      adapter.classifyStop({ payload: {}, transcriptPath, sentinelPresent: false, worktree }).kind,
    ).toBe("done");

    rmSync(join(middle, "done.json"));
    writeFileSync(join(middle, "failed.json"), JSON.stringify({ reason: "x" }));
    expect(
      adapter.classifyStop({ payload: {}, transcriptPath, sentinelPresent: false, worktree }).kind,
    ).toBe("failed");
  });

  test("detectRateLimit is implemented and returns null on a clean transcript", () => {
    const transcriptPath = join(dir, "clean.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({ type: "x", message: { content: "all good" } }));
    expect(adapter.detectRateLimit).toBeDefined();
    expect(adapter.detectRateLimit!({ payload: {}, transcriptPath })).toBeNull();
  });
});
