import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookPayload } from "@middle/core";
import {
  copilotAdapter,
  detectNeedsLogin,
  detectReadyForInput,
  detectTrustPrompt,
} from "../src/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "middle-copilot-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("copilotAdapter identity", () => {
  test("name is 'copilot' and readyEvent is session.started", () => {
    expect(copilotAdapter.name).toBe("copilot");
    expect(copilotAdapter.readyEvent).toBe("session.started");
  });

  test("sets the prompt-triggered-session flag (fires no sessionStart until a prompt)", () => {
    expect(copilotAdapter.startsSessionOnFirstPrompt).toBe(true);
  });
});

describe("buildLaunchCommand", () => {
  test("argv launches interactive copilot in auto mode (no -p, no prompt)", () => {
    const { argv } = copilotAdapter.buildLaunchCommand({
      worktree: dir,
      sessionName: "middle-124",
      sessionToken: "tok",
    });
    expect(argv).toEqual(["copilot", "--allow-all-tools"]);
    expect(argv).not.toContain("-p"); // never the non-interactive/headless mode
  });

  test("env sets COPILOT_HOME to the worktree-local .copilot so the config + hooks load", () => {
    const { env } = copilotAdapter.buildLaunchCommand({
      worktree: dir,
      sessionName: "middle-124",
      sessionToken: "tok",
    });
    expect(env.COPILOT_HOME).toBe(join(dir, ".copilot"));
    expect(env.COPILOT_ALLOW_ALL).toBe("true");
  });

  test("env carries the session vars and merges envOverrides", () => {
    const { env } = copilotAdapter.buildLaunchCommand({
      worktree: dir,
      sessionName: "middle-124",
      sessionToken: "secret-token",
      envOverrides: { MIDDLE_DISPATCHER_URL: "http://127.0.0.1:4120", MIDDLE_EPIC: "124" },
    });
    expect(env.MIDDLE_SESSION).toBe("middle-124");
    expect(env.MIDDLE_SESSION_TOKEN).toBe("secret-token");
    expect(env.MIDDLE_DISPATCHER_URL).toBe("http://127.0.0.1:4120");
    expect(env.MIDDLE_EPIC).toBe("124");
  });

  test("forwards an exported gh token so token-auth keeps working under the repointed home", () => {
    const prev = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "gho_test_token";
    try {
      const { env } = copilotAdapter.buildLaunchCommand({
        worktree: dir,
        sessionName: "middle-124",
        sessionToken: "tok",
      });
      expect(env.GH_TOKEN).toBe("gho_test_token");
    } finally {
      if (prev === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = prev;
    }
  });
});

describe("buildPromptText", () => {
  test("initial force-invokes the skill via slash command on the epic", () => {
    expect(
      copilotAdapter.buildPromptText({
        promptFile: ".middle/prompt.md",
        kind: "initial",
        epicRef: "124",
      }),
    ).toBe("/implementing-github-issues implement #124");
  });

  test("resume frames the @-reference as a continuation", () => {
    const text = copilotAdapter.buildPromptText({
      promptFile: ".middle/resume.md",
      kind: "resume",
      epicRef: "124",
    });
    expect(text).toContain("@.middle/resume.md");
    expect(text.toLowerCase()).toContain("resum");
  });

  test("answer frames the @-reference as a human reply", () => {
    const text = copilotAdapter.buildPromptText({
      promptFile: ".middle/answer.md",
      kind: "answer",
      epicRef: "124",
    });
    expect(text).toContain("@.middle/answer.md");
    expect(text.toLowerCase()).toContain("answer");
  });

  test("recommender / docs force-invoke their skill with the @-referenced context", () => {
    expect(
      copilotAdapter.buildPromptText({ promptFile: ".middle/prompt.md", kind: "recommender" }),
    ).toBe("/recommending-github-issues @.middle/prompt.md");
    expect(copilotAdapter.buildPromptText({ promptFile: ".middle/prompt.md", kind: "docs" })).toBe(
      "/documenting-the-repo @.middle/prompt.md",
    );
  });

  // Compile-time contract (enforced by `bun run typecheck`): same discriminated
  // union as Claude/Codex — a dispatched-issue kind cannot omit its Epic and the
  // repo-level kinds cannot carry one.
  test("type contract: dispatched-issue kinds require an epicRef; recommender forbids one", () => {
    // @ts-expect-error — 'initial' must carry an epicRef
    copilotAdapter.buildPromptText({ promptFile: ".middle/prompt.md", kind: "initial" });
    // @ts-expect-error — 'resume' must carry an epicRef
    copilotAdapter.buildPromptText({ promptFile: ".middle/prompt.md", kind: "resume" });
    // @ts-expect-error — 'answer' must carry an epicRef
    copilotAdapter.buildPromptText({ promptFile: ".middle/prompt.md", kind: "answer" });
    // @ts-expect-error — 'recommender' runs against no Epic, so epicRef is forbidden
    copilotAdapter.buildPromptText({
      promptFile: ".middle/prompt.md",
      kind: "recommender",
      epicRef: "1",
    });
    // @ts-expect-error — 'docs' runs against no Epic, so epicRef is forbidden
    copilotAdapter.buildPromptText({ promptFile: ".middle/prompt.md", kind: "docs", epicRef: "1" });
    expect(true).toBe(true);
  });
});

describe("resolveTranscriptPath", () => {
  // Real sessionStart payload shape captured from copilot 1.0.54 (camelCase, no path).
  test("derives <cwd>/.copilot/session-state/<sessionId>/events.jsonl from the payload", () => {
    const payload: HookPayload = {
      sessionId: "21573789-5bd5-4893-9fdf-2349dbdae0ed",
      timestamp: 1780532904525,
      cwd: "/home/u/wt",
      source: "new",
      initialPrompt: "implement #124",
    };
    expect(copilotAdapter.resolveTranscriptPath(payload)).toBe(
      "/home/u/wt/.copilot/session-state/21573789-5bd5-4893-9fdf-2349dbdae0ed/events.jsonl",
    );
  });

  test("falls back to snake_case session_id defensively", () => {
    const payload: HookPayload = { session_id: "abc-123", cwd: "/wt" };
    expect(copilotAdapter.resolveTranscriptPath(payload)).toBe(
      "/wt/.copilot/session-state/abc-123/events.jsonl",
    );
  });

  test("throws when the payload carries no sessionId", () => {
    expect(() => copilotAdapter.resolveTranscriptPath({ cwd: "/wt" })).toThrow(/sessionId/);
  });

  test.each(["../../../../etc/passwd", "a/b", "..", "id with spaces", "id;rm -rf"])(
    "rejects a non-identifier sessionId %p (defense-in-depth against path escape)",
    (sessionId) => {
      expect(() => copilotAdapter.resolveTranscriptPath({ sessionId, cwd: "/wt" })).toThrow(
        /not a plain identifier/,
      );
    },
  );
});

/** Build one real-shaped Copilot events.jsonl line. */
function ev(type: string, timestamp: string, data: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, timestamp, id: "x", parentId: null, data });
}

describe("readTranscriptState", () => {
  test("parses a real-shaped events.jsonl: activity, turn count, last tool use, context tokens", () => {
    const transcript = join(dir, "events.jsonl");
    writeFileSync(
      transcript,
      [
        ev("session.start", "2026-06-04T00:28:24.000Z"),
        ev("user.message", "2026-06-04T00:28:24.424Z", { content: "go" }),
        ev("assistant.message", "2026-06-04T00:28:27.498Z", { outputTokens: 117, content: "" }),
        ev("tool.execution_start", "2026-06-04T00:28:27.499Z", { toolName: "report_intent" }),
        ev("tool.execution_start", "2026-06-04T00:28:27.520Z", { toolName: "bash" }),
        ev("tool.execution_complete", "2026-06-04T00:28:27.971Z", { success: true }),
        ev("assistant.turn_end", "2026-06-04T00:28:27.994Z", { turnId: "0" }),
        "", // trailing blank line — must be tolerated
      ].join("\n"),
    );
    const state = copilotAdapter.readTranscriptState(transcript);
    expect(state.lastActivity).toBe("2026-06-04T00:28:27.994Z");
    expect(state.turnCount).toBe(1); // one assistant.turn_end
    expect(state.lastToolUse).toBe("bash"); // last tool.execution_start
    expect(state.contextTokens).toBe(117); // last assistant.message outputTokens
  });

  test("counts each assistant.turn_end as a turn", () => {
    const transcript = join(dir, "two-turns.jsonl");
    writeFileSync(
      transcript,
      [
        ev("assistant.turn_end", "2026-06-04T00:28:27.994Z", { turnId: "0" }),
        ev("assistant.turn_end", "2026-06-04T00:29:30.000Z", { turnId: "1" }),
      ].join("\n"),
    );
    expect(copilotAdapter.readTranscriptState(transcript).turnCount).toBe(2);
  });

  test("tolerates a corrupt line without throwing", () => {
    const transcript = join(dir, "corrupt.jsonl");
    writeFileSync(
      transcript,
      ["{ not json", ev("assistant.turn_end", "2026-06-04T00:28:27.994Z")].join("\n"),
    );
    const state = copilotAdapter.readTranscriptState(transcript);
    expect(state.turnCount).toBe(1);
    expect(state.lastActivity).toBe("2026-06-04T00:28:27.994Z");
  });
});

function writeMiddleDir(): { cwd: string; middle: string; transcript: string } {
  const cwd = join(dir, "worktree");
  const middle = join(cwd, ".middle");
  mkdirSync(middle, { recursive: true });
  const transcript = join(dir, "stop.jsonl");
  writeFileSync(transcript, "");
  return { cwd, middle, transcript };
}

describe("classifyStop", () => {
  test("sentinelPresent → asked-question, surfacing the blocked.json path + question/context", () => {
    const { cwd, middle, transcript } = writeMiddleDir();
    writeFileSync(
      join(middle, "blocked.json"),
      JSON.stringify({ question: "A or B?", context: "Both pass typecheck." }),
    );
    const result = copilotAdapter.classifyStop({
      payload: { cwd },
      transcriptPath: transcript,
      sentinelPresent: true,
      worktree: cwd,
    });
    expect(result.kind).toBe("asked-question");
    if (result.kind === "asked-question") {
      expect(result.sentinelPath).toBe(join(cwd, ".middle", "blocked.json"));
      expect(result.sentinel).toEqual({ question: "A or B?", context: "Both pass typecheck." });
    }
  });

  test("a blocked.json with kind 'complexity' surfaces the complexity pause kind", () => {
    const { cwd, middle, transcript } = writeMiddleDir();
    writeFileSync(
      join(middle, "blocked.json"),
      JSON.stringify({ question: "4 designs, no winner", kind: "complexity" }),
    );
    const result = copilotAdapter.classifyStop({
      payload: { cwd },
      transcriptPath: transcript,
      sentinelPresent: true,
      worktree: cwd,
    });
    expect(result.kind).toBe("asked-question");
    if (result.kind === "asked-question") {
      expect(result.sentinel).toEqual({ question: "4 designs, no winner", kind: "complexity" });
    }
  });

  test("asked-question tolerates a malformed blocked.json (sentinel → null)", () => {
    const { cwd, middle, transcript } = writeMiddleDir();
    writeFileSync(join(middle, "blocked.json"), "{ not valid json");
    const result = copilotAdapter.classifyStop({
      payload: { cwd },
      transcriptPath: transcript,
      sentinelPresent: true,
      worktree: cwd,
    });
    expect(result.kind).toBe("asked-question");
    if (result.kind === "asked-question") expect(result.sentinel).toBeNull();
  });

  test.each([
    ["You've hit a rate limit, try later.", "rate limit phrase"],
    ["Error 429: Too Many Requests", "429 status"],
    ["too many requests — slow down", "too many requests phrase"],
    ["ratelimit exceeded", "ratelimit no-space"],
    ["weekly quota exceeded for this model", "quota exceeded"],
    ["You have reached your usage limit", "usage limit"],
  ])("rate-limit text %p → rate-limited (%s)", (text) => {
    const { cwd, transcript } = writeMiddleDir();
    writeFileSync(
      transcript,
      ev("assistant.message", "2026-06-04T12:30:00.000Z", { content: text }),
    );
    const result = copilotAdapter.classifyStop({
      payload: {},
      transcriptPath: transcript,
      sentinelPresent: false,
      worktree: cwd,
    });
    expect(result.kind).toBe("rate-limited");
    if (result.kind === "rate-limited") expect(result.resetAt).toBe("unknown");
  });

  test.each([
    ["line 4290 of the file", "4290 — a line number"],
    ["commit 4291abcdef", "4291 in a hash"],
    ["listening on port 14290", "embedded 4290"],
    ["processed 42900 rows", "42900"],
  ])("a bare %p is NOT a rate-limit signal → bare-stop (%s)", (text) => {
    const { cwd, transcript } = writeMiddleDir();
    writeFileSync(
      transcript,
      ev("assistant.message", "2026-06-04T12:30:00.000Z", { content: text }),
    );
    const result = copilotAdapter.classifyStop({
      payload: {},
      transcriptPath: transcript,
      sentinelPresent: false,
      worktree: cwd,
    });
    expect(result.kind).toBe("bare-stop");
  });

  test("done.json sentinel → done", () => {
    const { cwd, middle, transcript } = writeMiddleDir();
    writeFileSync(join(middle, "done.json"), JSON.stringify({ pr: 207 }));
    const result = copilotAdapter.classifyStop({
      payload: { cwd },
      transcriptPath: transcript,
      sentinelPresent: false,
      worktree: cwd,
    });
    expect(result.kind).toBe("done");
  });

  test("failed.json sentinel → failed, carrying its reason", () => {
    const { cwd, middle, transcript } = writeMiddleDir();
    writeFileSync(join(middle, "failed.json"), JSON.stringify({ reason: "boom" }));
    const result = copilotAdapter.classifyStop({
      payload: { cwd },
      transcriptPath: transcript,
      sentinelPresent: false,
      worktree: cwd,
    });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("boom");
  });

  // Precedence: the authoritative terminal sentinels the skill writes outrank a
  // stale rate-limit line a finished session may have left in the transcript
  // tail — otherwise a completed/failed session misroutes to rate-limited.
  test("done.json outranks stale rate-limit text in the transcript → done", () => {
    const { cwd, middle, transcript } = writeMiddleDir();
    writeFileSync(join(middle, "done.json"), JSON.stringify({ pr: 207 }));
    writeFileSync(
      transcript,
      ev("assistant.message", "2026-06-04T12:30:00.000Z", { content: "Error 429: Too Many Requests" }),
    );
    const result = copilotAdapter.classifyStop({
      payload: {},
      transcriptPath: transcript,
      sentinelPresent: false,
      worktree: cwd,
    });
    expect(result.kind).toBe("done");
  });

  test("failed.json outranks stale rate-limit text in the transcript → failed", () => {
    const { cwd, middle, transcript } = writeMiddleDir();
    writeFileSync(join(middle, "failed.json"), JSON.stringify({ reason: "boom" }));
    writeFileSync(
      transcript,
      ev("assistant.message", "2026-06-04T12:30:00.000Z", { content: "weekly quota exceeded" }),
    );
    const result = copilotAdapter.classifyStop({
      payload: {},
      transcriptPath: transcript,
      sentinelPresent: false,
      worktree: cwd,
    });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("boom");
  });

  test("sentinels are found even when payload.cwd is a worktree subdirectory", () => {
    const { cwd: worktree, middle, transcript } = writeMiddleDir();
    writeFileSync(join(middle, "done.json"), JSON.stringify({ pr: 207 }));
    const subdir = join(worktree, "src");
    mkdirSync(subdir);
    const result = copilotAdapter.classifyStop({
      payload: { cwd: subdir },
      transcriptPath: transcript,
      sentinelPresent: false,
      worktree,
    });
    expect(result.kind).toBe("done");
  });

  test("nothing notable → bare-stop", () => {
    const { cwd, transcript } = writeMiddleDir();
    const result = copilotAdapter.classifyStop({
      payload: { cwd },
      transcriptPath: transcript,
      sentinelPresent: false,
      worktree: cwd,
    });
    expect(result.kind).toBe("bare-stop");
  });
});

describe("detectRateLimit", () => {
  test("text rate-limit signal → detection with unknown reset (no structured block on disk)", () => {
    const transcript = join(dir, "rl.jsonl");
    writeFileSync(
      transcript,
      ev("assistant.message", "2026-06-04T12:30:00.000Z", { content: "429 Too Many Requests" }),
    );
    const result = copilotAdapter.detectRateLimit!({ payload: {}, transcriptPath: transcript });
    expect(result).not.toBeNull();
    expect(result!.source).toBe("stop-hook");
    expect(result!.resetAt).toBe("unknown");
  });

  test("returns null when no rate-limit signal is present", () => {
    const transcript = join(dir, "none.jsonl");
    writeFileSync(
      transcript,
      ev("assistant.message", "2026-06-04T12:30:00.000Z", { content: "all good" }),
    );
    expect(copilotAdapter.detectRateLimit!({ payload: {}, transcriptPath: transcript })).toBeNull();
  });
});

describe("installHooks", () => {
  async function installInto(worktree: string): Promise<void> {
    await copilotAdapter.installHooks({
      worktree,
      hookScriptPath: ".middle/hooks/hook.sh",
      dispatcherUrl: "http://127.0.0.1:4120",
      sessionName: "middle-124",
      sessionToken: "tok",
      epicRef: "124",
    });
  }

  type CommandHook = { type: string; command: string; matcher?: string; timeoutSec?: number };
  type HooksFile = { version: number; hooks: Record<string, CommandHook[]> };

  async function readHooks(worktree: string): Promise<HooksFile> {
    const raw = await Bun.file(join(worktree, ".copilot", "hooks", "middle.json")).text();
    return JSON.parse(raw) as HooksFile;
  }

  test("writes .copilot/hooks/middle.json with version 1 and the camelCase event keys", async () => {
    const worktree = join(dir, "wt-events");
    mkdirSync(worktree, { recursive: true });
    await installInto(worktree);
    const cfg = await readHooks(worktree);
    expect(cfg.version).toBe(1);
    expect(Object.keys(cfg.hooks).sort()).toEqual([
      "postToolUse",
      "preToolUse",
      "sessionEnd",
      "sessionStart",
      "userPromptSubmitted",
    ]);
  });

  test("maps each Copilot event to the normalized taxonomy via the absolute hook path", async () => {
    const worktree = join(dir, "wt-map");
    mkdirSync(worktree, { recursive: true });
    await installInto(worktree);
    const cfg = await readHooks(worktree);
    const abs = join(worktree, ".middle/hooks/hook.sh");
    const cmd = (event: string): string => cfg.hooks[event]![0]!.command;
    expect(cmd("sessionStart")).toBe(`sh "${abs}" session.started`);
    expect(cmd("userPromptSubmitted")).toBe(`sh "${abs}" turn.started`);
    expect(cmd("preToolUse")).toBe(`sh "${abs}" tool.pre`);
    expect(cmd("postToolUse")).toBe(`sh "${abs}" tool.post`);
    // The load-bearing seam: Copilot has no per-turn stop, so sessionEnd IS the
    // turn boundary the dispatcher reacts to.
    expect(cmd("sessionEnd")).toBe(`sh "${abs}" agent.stopped`);
    expect(cfg.hooks.sessionStart![0]!.type).toBe("command");
  });

  test("registers the PR-ready gate as a SECOND preToolUse hook scoped to the bash tool", async () => {
    const worktree = join(dir, "wt-gate");
    mkdirSync(worktree, { recursive: true });
    await installInto(worktree);
    const cfg = await readHooks(worktree);
    const groups = cfg.hooks.preToolUse!;
    expect(groups).toHaveLength(2);
    // First group stays the universal heartbeat (no matcher, tool.pre).
    expect(groups[0]!.matcher).toBeUndefined();
    expect(groups[0]!.command).toBe(`sh "${join(worktree, ".middle/hooks/hook.sh")}" tool.pre`);
    // Second group is the bash-scoped blocking gate.
    expect(groups[1]!.matcher).toBe("bash");
    expect(groups[1]!.command).toBe(`sh "${join(worktree, ".middle/hooks/pr-ready-gate.sh")}"`);
  });

  test("pre-trusts the worktree in config.json so copilot skips the folder-trust dialog", async () => {
    const worktree = join(dir, "wt-trust");
    mkdirSync(worktree, { recursive: true });
    await installInto(worktree);
    const cfg = JSON.parse(await Bun.file(join(worktree, ".copilot", "config.json")).text()) as {
      trustedFolders: string[];
    };
    expect(cfg.trustedFolders).toContain(worktree);
  });

  test("writes an executable hook.sh into the worktree at the configured path", async () => {
    const worktree = join(dir, "wt-script");
    mkdirSync(worktree, { recursive: true });
    await installInto(worktree);
    const scriptPath = join(worktree, ".middle/hooks/hook.sh");
    const contents = await Bun.file(scriptPath).text();
    expect(contents).toStartWith("#!/bin/sh");
    expect(contents).toContain("curl");
    expect(contents).toContain("${MIDDLE_DISPATCHER_URL}");
    const { stat } = await import("node:fs/promises");
    expect(((await stat(scriptPath)).mode & 0o111) !== 0).toBe(true);
  });

  test("writes an executable pr-ready-gate.sh that POSTs to /gates/pr-ready", async () => {
    const worktree = join(dir, "wt-gate-script");
    mkdirSync(worktree, { recursive: true });
    await installInto(worktree);
    const scriptPath = join(worktree, ".middle/hooks/pr-ready-gate.sh");
    const contents = await Bun.file(scriptPath).text();
    expect(contents).toStartWith("#!/bin/sh");
    expect(contents).toContain("${MIDDLE_DISPATCHER_URL}/gates/pr-ready");
    expect(contents).toContain("exit 2");
  });

  test("writes NO auth file (copilot authenticates via gh, unlike codex)", async () => {
    const worktree = join(dir, "wt-noauth");
    mkdirSync(worktree, { recursive: true });
    await installInto(worktree);
    // No auth.json / credentials file is created under the worktree-local home.
    expect(existsSync(join(worktree, ".copilot", "auth.json"))).toBe(false);
    expect(existsSync(join(worktree, ".copilot", "apps.json"))).toBe(false);
    // The .copilot home exists (hooks + config were written).
    expect(lstatSync(join(worktree, ".copilot")).isDirectory()).toBe(true);
  });
});

describe("detectNeedsLogin", () => {
  test("matches representative not-authenticated messages", () => {
    expect(detectNeedsLogin("Please run copilot login to authenticate")).toBe(true);
    expect(detectNeedsLogin("You are not logged in")).toBe(true);
    expect(detectNeedsLogin("Not authenticated — please sign in")).toBe(true);
    expect(detectNeedsLogin("Run gh auth login first")).toBe(true);
  });

  test("does not match normal pane content", () => {
    expect(detectNeedsLogin("❯ ")).toBe(false);
    expect(detectNeedsLogin("Copilot v1.0.54")).toBe(false);
    expect(detectNeedsLogin("")).toBe(false);
  });
});

describe("detectReadyForInput", () => {
  test("matches the live composer-ready footer / prompt (copilot 1.0.54)", () => {
    // Captured off a real copilot 1.0.54 launch once the composer is ready.
    const pane = [
      " /tmp/worktree [⎇ master%]                                    AI Credits: 0",
      "────────────────────────────────────────────────────────────────────────",
      "❯",
      "────────────────────────────────────────────────────────────────────────",
      " / commands · ? help                                       Claude Sonnet 4.6",
    ].join("\n");
    expect(detectReadyForInput(pane)).toBe(true);
  });

  test("does not match a bare boot screen with no composer", () => {
    expect(detectReadyForInput("  ╭─╮╭─╮\n  ╰─╯╰─╯  Copilot v1.0.54 uses AI.")).toBe(false);
    expect(detectReadyForInput("")).toBe(false);
  });
});

describe("detectTrustPrompt", () => {
  test("matches a folder-trust dialog (defense-in-depth; pre-empted by trustedFolders)", () => {
    expect(detectTrustPrompt("Do you trust the files in this folder?")).toBe(true);
    expect(detectTrustPrompt("Trust this directory to run Copilot?")).toBe(true);
  });

  test("does not match a normal pane", () => {
    expect(detectTrustPrompt("❯ ")).toBe(false);
  });
});

describe("enterAutoMode", () => {
  // A non-ready terminal exit must REJECT, never resolve: resolving is the
  // single "composer is ready" signal the caller relies on to start sending the
  // prompt-first keystrokes. A vanished session resolving would feed those keys
  // into a dead session. (Boot-window timeout shares this contract but isn't
  // unit-exercised — forcing a 90s deadline would stall the suite; it's covered
  // by the live verify script and the shared throw path.)
  test("throws fast when the target session does not exist (never treated as ready)", async () => {
    const start = Date.now();
    await expect(
      copilotAdapter.enterAutoMode({ sessionName: "middle-does-not-exist" }),
    ).rejects.toThrow(/disappeared|capture-pane|ready-for-input/i);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
