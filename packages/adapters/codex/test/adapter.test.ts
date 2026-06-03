import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookPayload } from "@middle/core";
import { parse as parseToml } from "smol-toml";
import { codexAdapter, detectNeedsLogin } from "../src/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "middle-codex-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("codexAdapter identity", () => {
  test("name is 'codex' and readyEvent is session.started", () => {
    expect(codexAdapter.name).toBe("codex");
    expect(codexAdapter.readyEvent).toBe("session.started");
  });
});

describe("buildLaunchCommand", () => {
  test("argv launches interactive codex (no exec, no prompt)", () => {
    const { argv } = codexAdapter.buildLaunchCommand({
      worktree: dir,
      sessionName: "middle-60",
      sessionToken: "tok",
    });
    expect(argv).toEqual(["codex"]);
    expect(argv).not.toContain("exec"); // never the headless/non-interactive subcommand
    // approval_policy / sandbox live in .codex/config.toml, NOT the command line.
    expect(argv.join(" ")).not.toContain("approval");
    expect(argv.join(" ")).not.toContain("sandbox");
  });

  test("env carries the session vars and merges envOverrides", () => {
    const { env } = codexAdapter.buildLaunchCommand({
      worktree: dir,
      sessionName: "middle-60",
      sessionToken: "secret-token",
      envOverrides: { MIDDLE_DISPATCHER_URL: "http://127.0.0.1:4120", MIDDLE_EPIC: "60" },
    });
    expect(env.MIDDLE_SESSION).toBe("middle-60");
    expect(env.MIDDLE_SESSION_TOKEN).toBe("secret-token");
    expect(env.MIDDLE_DISPATCHER_URL).toBe("http://127.0.0.1:4120");
    expect(env.MIDDLE_EPIC).toBe("60");
  });
});

describe("buildPromptText", () => {
  test("initial force-invokes the skill via slash command on the epic", () => {
    expect(
      codexAdapter.buildPromptText({
        promptFile: ".middle/prompt.md",
        kind: "initial",
        epicRef: "60",
      }),
    ).toBe("/implementing-github-issues implement #60");
  });

  test("resume frames the @-reference as a continuation", () => {
    const text = codexAdapter.buildPromptText({
      promptFile: ".middle/resume.md",
      kind: "resume",
      epicRef: "60",
    });
    expect(text).toContain("@.middle/resume.md");
    expect(text.toLowerCase()).toContain("resum");
  });

  test("answer frames the @-reference as a human reply", () => {
    const text = codexAdapter.buildPromptText({
      promptFile: ".middle/answer.md",
      kind: "answer",
      epicRef: "60",
    });
    expect(text).toContain("@.middle/answer.md");
    expect(text.toLowerCase()).toContain("answer");
  });

  test("recommender force-invokes the recommender skill with the @-referenced context", () => {
    expect(
      codexAdapter.buildPromptText({ promptFile: ".middle/prompt.md", kind: "recommender" }),
    ).toBe("/recommending-github-issues @.middle/prompt.md");
  });

  test("docs force-invokes the documenting-the-repo skill with the @-referenced context", () => {
    expect(codexAdapter.buildPromptText({ promptFile: ".middle/prompt.md", kind: "docs" })).toBe(
      "/documenting-the-repo @.middle/prompt.md",
    );
  });

  // Compile-time contract (enforced by `bun run typecheck`): same discriminated
  // union as Claude — a dispatched-issue kind cannot omit its Epic and the
  // repo-level kinds cannot carry one.
  test("type contract: dispatched-issue kinds require an epicRef; recommender forbids one", () => {
    // @ts-expect-error — 'initial' must carry an epicRef
    codexAdapter.buildPromptText({ promptFile: ".middle/prompt.md", kind: "initial" });
    // @ts-expect-error — 'resume' must carry an epicRef
    codexAdapter.buildPromptText({ promptFile: ".middle/prompt.md", kind: "resume" });
    // @ts-expect-error — 'answer' must carry an epicRef
    codexAdapter.buildPromptText({ promptFile: ".middle/prompt.md", kind: "answer" });
    // @ts-expect-error — 'recommender' runs against no Epic, so epicRef is forbidden
    codexAdapter.buildPromptText({
      promptFile: ".middle/prompt.md",
      kind: "recommender",
      epicRef: "1",
    });
    // @ts-expect-error — 'docs' runs against no Epic, so epicRef is forbidden
    codexAdapter.buildPromptText({ promptFile: ".middle/prompt.md", kind: "docs", epicRef: "1" });
    expect(true).toBe(true);
  });
});

describe("resolveTranscriptPath", () => {
  test("returns transcript_path from the startup payload", () => {
    const payload: HookPayload = {
      session_id: "abc",
      transcript_path: "/home/u/.codex/sessions/2026/05/rollout-abc.jsonl",
    };
    expect(codexAdapter.resolveTranscriptPath(payload)).toBe(
      "/home/u/.codex/sessions/2026/05/rollout-abc.jsonl",
    );
  });

  test("falls back to rollout_path when transcript_path is absent", () => {
    const payload: HookPayload = { rollout_path: "/home/u/.codex/sessions/r.jsonl" };
    expect(codexAdapter.resolveTranscriptPath(payload)).toBe("/home/u/.codex/sessions/r.jsonl");
  });

  test("throws when the payload carries no session-file path", () => {
    expect(() => codexAdapter.resolveTranscriptPath({ session_id: "abc" })).toThrow();
  });
});

describe("readTranscriptState", () => {
  test("parses activity, turn count, last tool use, and context tokens from a rollout", () => {
    const transcript = join(dir, "rollout.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({
          timestamp: "2026-05-14T12:00:00.000Z",
          type: "session_meta",
          payload: { id: "s1" },
        }),
        JSON.stringify({
          timestamp: "2026-05-14T12:00:05.000Z",
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "text", text: "ok" }] },
        }),
        JSON.stringify({
          timestamp: "2026-05-14T12:00:08.000Z",
          type: "response_item",
          payload: { type: "function_call", name: "shell" },
        }),
        JSON.stringify({
          timestamp: "2026-05-14T12:00:10.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { total_token_usage: { input_tokens: 1500, cached_input_tokens: 500 } },
          },
        }),
        "", // trailing blank line — must be tolerated
      ].join("\n"),
    );
    const state = codexAdapter.readTranscriptState(transcript);
    expect(state.lastActivity).toBe("2026-05-14T12:00:10.000Z");
    expect(state.turnCount).toBe(1); // one assistant message
    expect(state.lastToolUse).toBe("shell");
    expect(state.contextTokens).toBe(2000); // 1500 input + 500 cached
  });

  test("tolerates a corrupt line without throwing", () => {
    const transcript = join(dir, "corrupt.jsonl");
    writeFileSync(
      transcript,
      [
        "{ not json",
        JSON.stringify({
          timestamp: "2026-05-14T12:00:01.000Z",
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "text", text: "hi" }] },
        }),
      ].join("\n"),
    );
    const state = codexAdapter.readTranscriptState(transcript);
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
      JSON.stringify({ question: "A or B?", context: "Both pass typecheck." }),
    );
    const result = codexAdapter.classifyStop({
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
    const result = codexAdapter.classifyStop({
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
    const result = codexAdapter.classifyStop({
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

  test.each([
    ["You've hit a rate limit, try later.", "rate limit phrase"],
    ["Error 429: Too Many Requests", "429 status"],
    ["too many requests — slow down", "too many requests phrase"],
    ["ratelimit exceeded", "ratelimit no-space"],
  ])("rate-limit signal %p in the transcript tail → rate-limited (%s)", (text) => {
    const { cwd, transcript } = writeMiddleDir();
    writeFileSync(
      transcript,
      JSON.stringify({
        timestamp: "2026-05-14T12:30:00.000Z",
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "text", text }] },
      }),
    );
    const result = codexAdapter.classifyStop({
      payload: { cwd },
      transcriptPath: transcript,
      sentinelPresent: false,
      worktree: cwd,
    });
    expect(result.kind).toBe("rate-limited");
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
      JSON.stringify({
        timestamp: "2026-05-14T12:30:00.000Z",
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "text", text }] },
      }),
    );
    const result = codexAdapter.classifyStop({
      payload: { cwd },
      transcriptPath: transcript,
      sentinelPresent: false,
      worktree: cwd,
    });
    expect(result.kind).toBe("bare-stop");
  });

  test("done.json sentinel → done", () => {
    const { cwd, middle, transcript } = writeMiddleDir();
    writeFileSync(join(middle, "done.json"), JSON.stringify({ pr: 155 }));
    const result = codexAdapter.classifyStop({
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
    const result = codexAdapter.classifyStop({
      payload: { cwd },
      transcriptPath: transcript,
      sentinelPresent: false,
      worktree: cwd,
    });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("boom");
  });

  test("sentinels are found even when payload.cwd is a worktree subdirectory", () => {
    const { cwd: worktree, middle, transcript } = writeMiddleDir();
    writeFileSync(join(middle, "done.json"), JSON.stringify({ pr: 155 }));
    const subdir = join(worktree, "src");
    mkdirSync(subdir);
    const result = codexAdapter.classifyStop({
      payload: { cwd: subdir },
      transcriptPath: transcript,
      sentinelPresent: false,
      worktree,
    });
    expect(result.kind).toBe("done");
  });

  test("nothing notable → bare-stop", () => {
    const { cwd, transcript } = writeMiddleDir();
    const result = codexAdapter.classifyStop({
      payload: { cwd },
      transcriptPath: transcript,
      sentinelPresent: false,
      worktree: cwd,
    });
    expect(result.kind).toBe("bare-stop");
  });
});

describe("detectRateLimit", () => {
  test("matches a rate-limit signal in the transcript tail", () => {
    const transcript = join(dir, "rl.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "429 Too Many Requests" }],
        },
      }),
    );
    const result = codexAdapter.detectRateLimit!({ payload: {}, transcriptPath: transcript });
    expect(result).not.toBeNull();
    expect(result!.source).toBe("stop-hook");
  });

  test("returns null when no rate-limit signal is present", () => {
    const transcript = join(dir, "ok.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "response_item", payload: { text: "fine" } }));
    expect(codexAdapter.detectRateLimit!({ payload: {}, transcriptPath: transcript })).toBeNull();
  });
});

describe("installHooks", () => {
  async function installInto(worktree: string): Promise<void> {
    await codexAdapter.installHooks({
      worktree,
      hookScriptPath: ".middle/hooks/hook.sh",
      dispatcherUrl: "http://127.0.0.1:4120",
      sessionName: "middle-60",
      sessionToken: "tok",
      epicRef: "60",
    });
  }

  test("writes .codex/config.toml with auto-mode settings and a [hooks] block", async () => {
    const worktree = join(dir, "wt-cfg");
    mkdirSync(worktree, { recursive: true });
    await installInto(worktree);
    const raw = await Bun.file(join(worktree, ".codex", "config.toml")).text();
    const cfg = parseToml(raw) as {
      approval_policy: string;
      sandbox: string;
      hooks: Record<string, Array<{ command: string }>>;
    };
    expect(cfg.approval_policy).toBe("never");
    expect(cfg.sandbox).toBe("workspace-write");
    expect(cfg.hooks).toBeDefined();
  });

  test("maps each Codex hook event to the normalized taxonomy via the absolute hook path", async () => {
    const worktree = join(dir, "wt-map");
    mkdirSync(worktree, { recursive: true });
    await installInto(worktree);
    const raw = await Bun.file(join(worktree, ".codex", "config.toml")).text();
    const cfg = parseToml(raw) as { hooks: Record<string, Array<{ command: string }>> };
    const abs = join(worktree, ".middle/hooks/hook.sh");
    const cmd = (event: string): string => cfg.hooks[event]![0]!.command;
    expect(cmd("startup")).toBe(`sh "${abs}" session.started`);
    expect(cmd("turn-start")).toBe(`sh "${abs}" turn.started`);
    expect(cmd("command")).toBe(`sh "${abs}" tool.pre`);
    expect(cmd("command-success")).toBe(`sh "${abs}" tool.post`);
    expect(cmd("command-failure")).toBe(`sh "${abs}" tool.failed`);
    expect(cmd("turn-end")).toBe(`sh "${abs}" agent.stopped`);
    expect(cmd("shutdown")).toBe(`sh "${abs}" session.ended`);
  });

  test("registers the full Codex hook event set", async () => {
    const worktree = join(dir, "wt-events");
    mkdirSync(worktree, { recursive: true });
    await installInto(worktree);
    const raw = await Bun.file(join(worktree, ".codex", "config.toml")).text();
    const cfg = parseToml(raw) as { hooks: Record<string, unknown> };
    expect(Object.keys(cfg.hooks).sort()).toEqual([
      "command",
      "command-failure",
      "command-success",
      "shutdown",
      "startup",
      "turn-end",
      "turn-start",
    ]);
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

  test("registers the PR-ready gate as a second hook on the command (pre) event", async () => {
    const worktree = join(dir, "wt-gate");
    mkdirSync(worktree, { recursive: true });
    await installInto(worktree);
    const raw = await Bun.file(join(worktree, ".codex", "config.toml")).text();
    const cfg = parseToml(raw) as { hooks: Record<string, Array<{ command: string }>> };
    const commandHooks = cfg.hooks.command!;
    // First entry stays the universal heartbeat (tool.pre); the gate is added second.
    expect(commandHooks[0]!.command).toBe(
      `sh "${join(worktree, ".middle/hooks/hook.sh")}" tool.pre`,
    );
    expect(commandHooks[1]!.command).toBe(
      `sh "${join(worktree, ".middle/hooks/pr-ready-gate.sh")}"`,
    );
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
    const { stat } = await import("node:fs/promises");
    expect(((await stat(scriptPath)).mode & 0o111) !== 0).toBe(true);
  });
});

describe("detectNeedsLogin", () => {
  test("matches representative not-authenticated messages", () => {
    expect(detectNeedsLogin("Please run codex login to authenticate")).toBe(true);
    expect(detectNeedsLogin("You are not logged in")).toBe(true);
    expect(detectNeedsLogin("Not authenticated — please sign in")).toBe(true);
    expect(detectNeedsLogin("set OPENAI_API_KEY or run codex login")).toBe(true);
  });

  test("does not match normal pane content", () => {
    expect(detectNeedsLogin("> ")).toBe(false);
    expect(detectNeedsLogin("Codex CLI v0.1.0")).toBe(false);
    expect(detectNeedsLogin("")).toBe(false);
  });
});

describe("enterAutoMode", () => {
  test("returns immediately when the target session does not exist", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const start = Date.now();
    try {
      await expect(
        codexAdapter.enterAutoMode({ sessionName: "middle-does-not-exist" }),
      ).resolves.toBeUndefined();
    } finally {
      errSpy.mockRestore();
    }
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
