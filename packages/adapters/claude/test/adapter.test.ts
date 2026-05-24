import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookPayload } from "@middle/core";
import {
  claudeAdapter,
  detectBypassPrompt,
  detectNeedsLogin,
  detectTrustPrompt,
} from "../src/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "middle-claude-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("claudeAdapter identity", () => {
  test("name is 'claude' and readyEvent is session.started", () => {
    expect(claudeAdapter.name).toBe("claude");
    expect(claudeAdapter.readyEvent).toBe("session.started");
  });
});

describe("buildLaunchCommand", () => {
  test("argv launches interactive claude in auto mode via --dangerously-skip-permissions", () => {
    const { argv } = claudeAdapter.buildLaunchCommand({
      worktree: dir,
      sessionName: "middle-6",
      sessionToken: "tok",
    });
    expect(argv).toEqual(["claude", "--dangerously-skip-permissions"]);
    expect(argv).not.toContain("-p"); // never headless
    // bypassPermissions via --permission-mode would pop a one-time confirmation
    // prompt the dispatcher cannot answer — never use that variant.
    expect(argv).not.toContain("--permission-mode");
  });

  test("env carries the session vars and merges envOverrides", () => {
    const { env } = claudeAdapter.buildLaunchCommand({
      worktree: dir,
      sessionName: "middle-6",
      sessionToken: "secret-token",
      envOverrides: { MIDDLE_DISPATCHER_URL: "http://127.0.0.1:8822", MIDDLE_EPIC: "6" },
    });
    expect(env.MIDDLE_SESSION).toBe("middle-6");
    expect(env.MIDDLE_SESSION_TOKEN).toBe("secret-token");
    expect(env.MIDDLE_DISPATCHER_URL).toBe("http://127.0.0.1:8822");
    expect(env.MIDDLE_EPIC).toBe("6");
  });
});

describe("buildPromptText", () => {
  test("initial force-invokes the skill via slash command on the epic", () => {
    expect(
      claudeAdapter.buildPromptText({
        promptFile: ".middle/prompt.md",
        kind: "initial",
        epicNumber: 14,
      }),
    ).toBe("/implementing-github-issues implement #14");
  });

  test("resume frames the @-reference as a continuation", () => {
    const text = claudeAdapter.buildPromptText({
      promptFile: ".middle/resume.md",
      kind: "resume",
      epicNumber: 14,
    });
    expect(text).toContain("@.middle/resume.md");
    expect(text.toLowerCase()).toContain("resum");
  });

  test("answer frames the @-reference as a human reply", () => {
    const text = claudeAdapter.buildPromptText({
      promptFile: ".middle/answer.md",
      kind: "answer",
      epicNumber: 14,
    });
    expect(text).toContain("@.middle/answer.md");
    expect(text.toLowerCase()).toContain("answer");
  });
});

describe("resolveTranscriptPath", () => {
  test("returns transcript_path from the SessionStart payload", () => {
    const payload: HookPayload = {
      session_id: "abc",
      transcript_path: "/home/u/.claude/projects/x/abc.jsonl",
    };
    expect(claudeAdapter.resolveTranscriptPath(payload)).toBe(
      "/home/u/.claude/projects/x/abc.jsonl",
    );
  });

  test("throws when the payload has no transcript_path", () => {
    expect(() => claudeAdapter.resolveTranscriptPath({ session_id: "abc" })).toThrow();
  });
});

describe("readTranscriptState", () => {
  test("parses activity, turn count, last tool use, and context tokens", () => {
    const transcript = join(dir, "t.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "go" },
          timestamp: "2026-05-14T12:00:00.000Z",
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 },
          },
          timestamp: "2026-05-14T12:00:05.000Z",
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
            usage: { input_tokens: 200, cache_read_input_tokens: 1800, output_tokens: 30 },
          },
          timestamp: "2026-05-14T12:00:10.000Z",
        }),
        "", // trailing blank line — must be tolerated
      ].join("\n"),
    );
    const state = claudeAdapter.readTranscriptState(transcript);
    expect(state.lastActivity).toBe("2026-05-14T12:00:10.000Z");
    expect(state.turnCount).toBe(2);
    expect(state.lastToolUse).toBe("Bash");
    expect(state.contextTokens).toBe(2000); // 200 + 1800 from the last assistant turn
  });

  test("tolerates a corrupt line without throwing", () => {
    const transcript = join(dir, "corrupt.jsonl");
    writeFileSync(
      transcript,
      [
        "{ not json",
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
          timestamp: "2026-05-14T12:00:01.000Z",
        }),
      ].join("\n"),
    );
    const state = claudeAdapter.readTranscriptState(transcript);
    expect(state.turnCount).toBe(1);
    expect(state.lastActivity).toBe("2026-05-14T12:00:01.000Z");
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
      JSON.stringify({ question: "Use option A or B?", context: "Both pass typecheck." }),
    );
    const result = claudeAdapter.classifyStop({
      payload: { cwd },
      transcriptPath: transcript,
      sentinelPresent: true,
      worktree: cwd,
    });
    expect(result.kind).toBe("asked-question");
    if (result.kind === "asked-question") {
      expect(result.sentinelPath).toBe(join(cwd, ".middle", "blocked.json"));
      expect(result.sentinel).toEqual({
        question: "Use option A or B?",
        context: "Both pass typecheck.",
      });
    }
  });

  test("asked-question tolerates a malformed/contentless blocked.json (sentinel → null)", () => {
    const { cwd, middle, transcript } = writeMiddleDir();
    writeFileSync(join(middle, "blocked.json"), "{ not valid json");
    const result = claudeAdapter.classifyStop({
      payload: { cwd },
      transcriptPath: transcript,
      sentinelPresent: true,
      worktree: cwd,
    });
    expect(result.kind).toBe("asked-question");
    if (result.kind === "asked-question") {
      expect(result.sentinel).toBeNull();
    }
  });

  test("usage-limit message in the transcript tail → rate-limited", () => {
    const { cwd, transcript } = writeMiddleDir();
    writeFileSync(
      transcript,
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "You've hit your usage limit. Resets at 2026-05-14T18:00:00Z." },
          ],
        },
        timestamp: "2026-05-14T12:30:00.000Z",
      }),
    );
    const result = claudeAdapter.classifyStop({
      payload: { cwd },
      transcriptPath: transcript,
      sentinelPresent: false,
      worktree: cwd,
    });
    expect(result.kind).toBe("rate-limited");
    if (result.kind === "rate-limited") {
      expect(result.resetAt).toBe("2026-05-14T18:00:00Z");
    }
  });

  test("done.json sentinel → done", () => {
    const { cwd, middle, transcript } = writeMiddleDir();
    writeFileSync(join(middle, "done.json"), JSON.stringify({ pr: 73 }));
    const result = claudeAdapter.classifyStop({
      payload: { cwd },
      transcriptPath: transcript,
      sentinelPresent: false,
      worktree: cwd,
    });
    expect(result.kind).toBe("done");
  });

  test("failed.json sentinel → failed, carrying its reason", () => {
    const { cwd, middle, transcript } = writeMiddleDir();
    writeFileSync(join(middle, "failed.json"), JSON.stringify({ reason: "3 consecutive denials" }));
    const result = claudeAdapter.classifyStop({
      payload: { cwd },
      transcriptPath: transcript,
      sentinelPresent: false,
      worktree: cwd,
    });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toBe("3 consecutive denials");
    }
  });

  test("sentinels are found even when payload.cwd is a worktree subdirectory", () => {
    // Regression: agent did `cd src/` before stopping. `done.json` lives at the
    // worktree root and must still resolve `done`, not `bare-stop`.
    const { cwd: worktree, middle, transcript } = writeMiddleDir();
    writeFileSync(join(middle, "done.json"), JSON.stringify({ pr: 73 }));
    const subdir = join(worktree, "src");
    mkdirSync(subdir);
    const result = claudeAdapter.classifyStop({
      payload: { cwd: subdir },
      transcriptPath: transcript,
      sentinelPresent: false,
      worktree,
    });
    expect(result.kind).toBe("done");
  });

  test("nothing notable → bare-stop", () => {
    const { cwd, transcript } = writeMiddleDir();
    const result = claudeAdapter.classifyStop({
      payload: { cwd },
      transcriptPath: transcript,
      sentinelPresent: false,
      worktree: cwd,
    });
    expect(result.kind).toBe("bare-stop");
  });
});

describe("detectRateLimit", () => {
  test("matches a usage-limit message in the transcript tail", () => {
    const transcript = join(dir, "rl.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "You've hit your usage limit. Resets at 2026-05-23T18:00:00Z." },
          ],
        },
      }),
    );
    const result = claudeAdapter.detectRateLimit!({ payload: {}, transcriptPath: transcript });
    expect(result).not.toBeNull();
    expect(result!.resetAt).toBe("2026-05-23T18:00:00Z");
    expect(result!.source).toBe("stop-hook");
  });

  test("returns null when no usage-limit message is present", () => {
    const transcript = join(dir, "ok.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "assistant", message: { content: "fine" } }));
    expect(claudeAdapter.detectRateLimit!({ payload: {}, transcriptPath: transcript })).toBeNull();
  });
});

describe("installHooks", () => {
  async function installInto(worktree: string): Promise<void> {
    await claudeAdapter.installHooks({
      worktree,
      hookScriptPath: ".middle/hooks/hook.sh",
      dispatcherUrl: "http://127.0.0.1:8822",
      sessionName: "middle-6",
      sessionToken: "tok",
      epicNumber: 6,
    });
  }

  test("registers the full Claude hook event set in .claude/settings.json", async () => {
    const worktree = join(dir, "wt-events");
    mkdirSync(worktree, { recursive: true });
    await installInto(worktree);
    const settings = JSON.parse(
      await Bun.file(join(worktree, ".claude", "settings.json")).text(),
    ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(Object.keys(settings.hooks).sort()).toEqual([
      "Notification",
      "PostToolUse",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "SubagentStop",
      "UserPromptSubmit",
    ]);
  });

  test("each entry maps its Claude event to the normalized taxonomy via the absolute hook path", async () => {
    const worktree = join(dir, "wt-map");
    mkdirSync(worktree, { recursive: true });
    await installInto(worktree);
    const settings = JSON.parse(
      await Bun.file(join(worktree, ".claude", "settings.json")).text(),
    ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const abs = join(worktree, ".middle/hooks/hook.sh");
    const cmd = (event: string): string => settings.hooks[event]![0]!.hooks[0]!.command;
    expect(cmd("SessionStart")).toBe(`"${abs}" session.started`);
    expect(cmd("UserPromptSubmit")).toBe(`"${abs}" turn.started`);
    expect(cmd("PreToolUse")).toBe(`"${abs}" tool.pre`);
    expect(cmd("PostToolUse")).toBe(`"${abs}" tool.post`);
    expect(cmd("Notification")).toBe(`"${abs}" agent.notification`);
    expect(cmd("Stop")).toBe(`"${abs}" agent.stopped`);
    expect(cmd("SubagentStop")).toBe(`"${abs}" agent.subagent-stopped`);
    expect(cmd("SessionEnd")).toBe(`"${abs}" session.ended`);
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
    const mode = (await import("node:fs/promises")).stat(scriptPath);
    expect(((await mode).mode & 0o111) !== 0).toBe(true); // some exec bit set
  });

  test("registers the PR-ready gate as a second Bash-matched PreToolUse hook", async () => {
    const worktree = join(dir, "wt-gate");
    mkdirSync(worktree, { recursive: true });
    await installInto(worktree);
    const settings = JSON.parse(
      await Bun.file(join(worktree, ".claude", "settings.json")).text(),
    ) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    const preToolUse = settings.hooks.PreToolUse!;
    // First entry stays the universal heartbeat (all tools); the gate is added second.
    expect(preToolUse[0]!.hooks[0]!.command).toBe(
      `"${join(worktree, ".middle/hooks/hook.sh")}" tool.pre`,
    );
    const gateEntry = preToolUse[1]!;
    expect(gateEntry.matcher).toBe("Bash");
    expect(gateEntry.hooks[0]!.command).toBe(`"${join(worktree, ".middle/hooks/pr-ready-gate.sh")}"`);
  });

  test("writes an executable pr-ready-gate.sh that POSTs to /gates/pr-ready", async () => {
    const worktree = join(dir, "wt-gate-script");
    mkdirSync(worktree, { recursive: true });
    await installInto(worktree);
    const scriptPath = join(worktree, ".middle/hooks/pr-ready-gate.sh");
    const contents = await Bun.file(scriptPath).text();
    expect(contents).toStartWith("#!/bin/sh");
    expect(contents).toContain("${MIDDLE_DISPATCHER_URL}/gates/pr-ready");
    expect(contents).toContain("exit 2"); // blocks the tool on deny
    const { stat } = await import("node:fs/promises");
    expect(((await stat(scriptPath)).mode & 0o111) !== 0).toBe(true);
  });
});

describe("detectBypassPrompt", () => {
  test("matches representative bypass-mode confirmation strings", () => {
    expect(detectBypassPrompt("You are entering Bypass Permissions mode")).toBe(true);
    expect(detectBypassPrompt("skip permissions checks?")).toBe(true);
    expect(detectBypassPrompt("Running --dangerously-skip-permissions")).toBe(true);
  });

  test("does not match normal Claude pane content", () => {
    expect(detectBypassPrompt("> ")).toBe(false);
    expect(detectBypassPrompt("Welcome to Claude Code 2.1.142")).toBe(false);
    expect(detectBypassPrompt("")).toBe(false);
  });
});

describe("detectTrustPrompt", () => {
  test("matches the first-run folder-trust dialog", () => {
    expect(detectTrustPrompt("Do you trust the files in this folder?")).toBe(true);
    expect(detectTrustPrompt("1. Yes, I trust this folder  2. No, exit")).toBe(true);
    expect(detectTrustPrompt("Trust this directory and continue?")).toBe(true);
  });

  test("does not match the bypass dialog or normal content", () => {
    expect(detectTrustPrompt("You are entering Bypass Permissions mode")).toBe(false);
    expect(detectTrustPrompt("> ")).toBe(false);
    expect(detectTrustPrompt("")).toBe(false);
  });
});

describe("detectNeedsLogin", () => {
  test("matches representative not-authenticated messages", () => {
    expect(detectNeedsLogin("Please run claude login to authenticate")).toBe(true);
    expect(detectNeedsLogin("You are not logged in")).toBe(true);
    expect(detectNeedsLogin("Not authenticated — please sign in")).toBe(true);
    expect(detectNeedsLogin("Welcome to Claude Code — please sign in to continue")).toBe(true);
    expect(detectNeedsLogin("Invalid API key")).toBe(true);
  });

  test("does not match the bypass prompt or normal pane content", () => {
    expect(detectNeedsLogin("Bypass Permissions mode")).toBe(false);
    expect(detectNeedsLogin("> ")).toBe(false);
    expect(detectNeedsLogin("Loaded skill: implementing-github-issues")).toBe(false);
    expect(detectNeedsLogin("")).toBe(false);
  });
});

describe("enterAutoMode", () => {
  test("returns immediately when the target session does not exist", async () => {
    // capture-pane against a missing session fails → enterAutoMode bails fast,
    // never blocking the workflow when tmux state is unexpectedly gone
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const start = Date.now();
    try {
      await expect(
        claudeAdapter.enterAutoMode({ sessionName: "middle-does-not-exist" }),
      ).resolves.toBeUndefined();
    } finally {
      errSpy.mockRestore();
    }
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
