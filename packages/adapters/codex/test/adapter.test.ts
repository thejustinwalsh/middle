import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookPayload } from "@middle/core";
import { parse as parseToml } from "smol-toml";
import {
  codexAdapter,
  detectDirTrustPrompt,
  detectHooksTrustPrompt,
  detectNeedsLogin,
  detectReadyForInput,
} from "../src/index.ts";

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
      sessionName: "middle-177",
      sessionToken: "tok",
    });
    expect(argv).toEqual(["codex"]);
    expect(argv).not.toContain("exec"); // never the headless/non-interactive subcommand
    // approval_policy / sandbox_mode live in .codex/config.toml, NOT the command line.
    expect(argv.join(" ")).not.toContain("approval");
    expect(argv.join(" ")).not.toContain("sandbox");
  });

  test("env sets CODEX_HOME to the worktree-local .codex so the config is loaded", () => {
    const { env } = codexAdapter.buildLaunchCommand({
      worktree: dir,
      sessionName: "middle-177",
      sessionToken: "tok",
    });
    expect(env.CODEX_HOME).toBe(join(dir, ".codex"));
  });

  test("env carries the session vars and merges envOverrides", () => {
    const { env } = codexAdapter.buildLaunchCommand({
      worktree: dir,
      sessionName: "middle-177",
      sessionToken: "secret-token",
      envOverrides: { MIDDLE_DISPATCHER_URL: "http://127.0.0.1:4120", MIDDLE_EPIC: "177" },
    });
    expect(env.MIDDLE_SESSION).toBe("middle-177");
    expect(env.MIDDLE_SESSION_TOKEN).toBe("secret-token");
    expect(env.MIDDLE_DISPATCHER_URL).toBe("http://127.0.0.1:4120");
    expect(env.MIDDLE_EPIC).toBe("177");
  });
});

describe("buildPromptText", () => {
  test("initial force-invokes the skill via slash command on the epic", () => {
    expect(
      codexAdapter.buildPromptText({
        promptFile: ".middle/prompt.md",
        kind: "initial",
        epicRef: "177",
      }),
    ).toBe("/implementing-github-issues implement #177");
  });

  test("resume frames the @-reference as a continuation", () => {
    const text = codexAdapter.buildPromptText({
      promptFile: ".middle/resume.md",
      kind: "resume",
      epicRef: "177",
    });
    expect(text).toContain("@.middle/resume.md");
    expect(text.toLowerCase()).toContain("resum");
  });

  test("answer frames the @-reference as a human reply", () => {
    const text = codexAdapter.buildPromptText({
      promptFile: ".middle/answer.md",
      kind: "answer",
      epicRef: "177",
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
  // Real SessionStart payload shape captured from codex 0.133.0.
  test("returns transcript_path from the SessionStart payload", () => {
    const payload: HookPayload = {
      session_id: "019e7228-4ce0-78b3-9ee7-5784f3679c3f",
      transcript_path:
        "/home/u/.codex/sessions/2026/05/29/rollout-2026-05-29T01-15-04-019e7228.jsonl",
      cwd: "/home/u/wt",
      hook_event_name: "SessionStart",
      source: "startup",
    };
    expect(codexAdapter.resolveTranscriptPath(payload)).toBe(
      "/home/u/.codex/sessions/2026/05/29/rollout-2026-05-29T01-15-04-019e7228.jsonl",
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
  test("parses a real-shaped rollout: activity, turn count, last tool use, context tokens", () => {
    const transcript = join(dir, "rollout.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({
          timestamp: "2026-05-29T05:15:04.000Z",
          type: "session_meta",
          payload: { id: "s1", cwd: "/wt", originator: "codex_exec" },
        }),
        JSON.stringify({
          timestamp: "2026-05-29T05:15:04.100Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "t1" },
        }),
        JSON.stringify({
          timestamp: "2026-05-29T05:15:05.000Z",
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "text", text: "ok" }] },
        }),
        // A real shell tool call is a function_call named exec_command.
        JSON.stringify({
          timestamp: "2026-05-29T05:15:06.000Z",
          type: "response_item",
          payload: { type: "function_call", name: "exec_command", call_id: "c1" },
        }),
        JSON.stringify({
          timestamp: "2026-05-29T05:15:06.206Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 10590,
                cached_input_tokens: 2432,
                total_tokens: 10595,
              },
            },
          },
        }),
        "", // trailing blank line — must be tolerated
      ].join("\n"),
    );
    const state = codexAdapter.readTranscriptState(transcript);
    expect(state.lastActivity).toBe("2026-05-29T05:15:06.206Z");
    expect(state.turnCount).toBe(1); // one assistant message
    expect(state.lastToolUse).toBe("exec_command");
    expect(state.contextTokens).toBe(13022); // 10590 input + 2432 cached
  });

  test("tolerates a corrupt line without throwing", () => {
    const transcript = join(dir, "corrupt.jsonl");
    writeFileSync(
      transcript,
      [
        "{ not json",
        JSON.stringify({
          timestamp: "2026-05-29T05:15:01.000Z",
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "text", text: "hi" }] },
        }),
      ].join("\n"),
    );
    const state = codexAdapter.readTranscriptState(transcript);
    expect(state.turnCount).toBe(1);
    expect(state.lastActivity).toBe("2026-05-29T05:15:01.000Z");
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

/** Write a rollout whose last token_count carries the given rate_limits block. */
function writeRolloutWithRateLimits(path: string, rateLimits: unknown): void {
  writeFileSync(
    path,
    JSON.stringify({
      timestamp: "2026-05-29T05:15:06.206Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 0 } },
        rate_limits: rateLimits,
      },
    }),
  );
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

  test("structured rate_limits with rate_limit_reached_type → rate-limited, resetAt from resets_at", () => {
    const { cwd, transcript } = writeMiddleDir();
    // resets_at is epoch seconds.
    writeRolloutWithRateLimits(transcript, {
      rate_limit_reached_type: "primary",
      primary: { used_percent: 100, resets_at: 1780634498 },
      secondary: null,
    });
    const result = codexAdapter.classifyStop({
      payload: {},
      transcriptPath: transcript,
      sentinelPresent: false,
      worktree: cwd,
    });
    expect(result.kind).toBe("rate-limited");
    if (result.kind === "rate-limited") {
      expect(result.resetAt).toBe(new Date(1780634498 * 1000).toISOString());
    }
  });

  test("structured rate_limits at/over 100% used → rate-limited even without reached_type", () => {
    const { cwd, transcript } = writeMiddleDir();
    writeRolloutWithRateLimits(transcript, {
      rate_limit_reached_type: null,
      primary: { used_percent: 100, resets_at: 1780634498 },
    });
    const result = codexAdapter.classifyStop({
      payload: {},
      transcriptPath: transcript,
      sentinelPresent: false,
      worktree: cwd,
    });
    expect(result.kind).toBe("rate-limited");
  });

  test("a healthy structured block is authoritative → bare-stop, even with a stray '429' in text", () => {
    const { cwd, transcript } = writeMiddleDir();
    // Healthy: reached_type null, low usage. The structured block wins over the
    // incidental '429' substring that would trip the text fallback.
    writeFileSync(
      transcript,
      `${JSON.stringify({
        timestamp: "2026-05-29T05:15:06.206Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            rate_limit_reached_type: null,
            primary: { used_percent: 3.0, resets_at: 1780634498 },
          },
        },
      })}\n${JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "text", text: "429" }] },
      })}`,
    );
    const result = codexAdapter.classifyStop({
      payload: {},
      transcriptPath: transcript,
      sentinelPresent: false,
      worktree: cwd,
    });
    expect(result.kind).toBe("bare-stop");
  });

  test.each([
    ["You've hit a rate limit, try later.", "rate limit phrase"],
    ["Error 429: Too Many Requests", "429 status"],
    ["too many requests — slow down", "too many requests phrase"],
    ["ratelimit exceeded", "ratelimit no-space"],
  ])("text fallback (no structured block): %p → rate-limited (%s)", (text) => {
    const { cwd, transcript } = writeMiddleDir();
    // No token_count/rate_limits line → the text regex fallback applies.
    writeFileSync(
      transcript,
      JSON.stringify({
        timestamp: "2026-05-29T12:30:00.000Z",
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "text", text }] },
      }),
    );
    const result = codexAdapter.classifyStop({
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
      JSON.stringify({
        timestamp: "2026-05-29T12:30:00.000Z",
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "text", text }] },
      }),
    );
    const result = codexAdapter.classifyStop({
      payload: {},
      transcriptPath: transcript,
      sentinelPresent: false,
      worktree: cwd,
    });
    expect(result.kind).toBe("bare-stop");
  });

  test("done.json sentinel → done", () => {
    const { cwd, middle, transcript } = writeMiddleDir();
    writeFileSync(join(middle, "done.json"), JSON.stringify({ pr: 182 }));
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
    writeFileSync(join(middle, "done.json"), JSON.stringify({ pr: 182 }));
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
  test("structured block at the limit → detection with the real reset time", () => {
    const transcript = join(dir, "rl.jsonl");
    writeRolloutWithRateLimits(transcript, {
      rate_limit_reached_type: "primary",
      primary: { used_percent: 100, resets_at: 1780634498 },
    });
    const result = codexAdapter.detectRateLimit!({ payload: {}, transcriptPath: transcript });
    expect(result).not.toBeNull();
    expect(result!.source).toBe("stop-hook");
    expect(result!.resetAt).toBe(new Date(1780634498 * 1000).toISOString());
  });

  test("text fallback matches a rate-limit signal when no structured block exists", () => {
    const transcript = join(dir, "rl-text.jsonl");
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
    expect(result!.resetAt).toBe("unknown");
  });

  test("returns null when a healthy structured block is present", () => {
    const transcript = join(dir, "ok.jsonl");
    writeRolloutWithRateLimits(transcript, {
      rate_limit_reached_type: null,
      primary: { used_percent: 3.0, resets_at: 1780634498 },
    });
    expect(codexAdapter.detectRateLimit!({ payload: {}, transcriptPath: transcript })).toBeNull();
  });

  test("returns null when no rate-limit signal is present at all", () => {
    const transcript = join(dir, "none.jsonl");
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
      sessionName: "middle-177",
      sessionToken: "tok",
      epicRef: "177",
    });
  }

  type HookGroup = { matcher?: string; hooks: Array<{ type: string; command: string }> };
  type CodexConfig = {
    approval_policy: string;
    sandbox_mode: string;
    projects: Record<string, { trust_level: string }>;
    hooks: Record<string, HookGroup[]>;
  };

  async function readConfig(worktree: string): Promise<CodexConfig> {
    const raw = await Bun.file(join(worktree, ".codex", "config.toml")).text();
    return parseToml(raw) as unknown as CodexConfig;
  }

  test("writes .codex/config.toml with auto-mode + sandbox_mode (NOT the rejected 'sandbox' key)", async () => {
    const worktree = join(dir, "wt-cfg");
    mkdirSync(worktree, { recursive: true });
    await installInto(worktree);
    const raw = await Bun.file(join(worktree, ".codex", "config.toml")).text();
    expect(raw).not.toMatch(/^sandbox\s*=/m); // bare `sandbox` is rejected by --strict-config
    const cfg = await readConfig(worktree);
    expect(cfg.approval_policy).toBe("never");
    expect(cfg.sandbox_mode).toBe("workspace-write");
    expect((cfg as unknown as { sandbox?: unknown }).sandbox).toBeUndefined();
    expect(cfg.hooks).toBeDefined();
  });

  test("pre-trusts the worktree directory so codex skips the directory-trust dialog", async () => {
    const worktree = join(dir, "wt-trust");
    mkdirSync(worktree, { recursive: true });
    await installInto(worktree);
    const cfg = await readConfig(worktree);
    expect(cfg.projects[worktree]).toEqual({ trust_level: "trusted" });
  });

  test("maps each real Codex event to the normalized taxonomy via the absolute hook path", async () => {
    const worktree = join(dir, "wt-map");
    mkdirSync(worktree, { recursive: true });
    await installInto(worktree);
    const cfg = await readConfig(worktree);
    const abs = join(worktree, ".middle/hooks/hook.sh");
    const cmd = (event: string): string => cfg.hooks[event]![0]!.hooks[0]!.command;
    const handlerType = (event: string): string => cfg.hooks[event]![0]!.hooks[0]!.type;
    expect(cmd("SessionStart")).toBe(`sh "${abs}" session.started`);
    expect(cmd("UserPromptSubmit")).toBe(`sh "${abs}" turn.started`);
    expect(cmd("PreToolUse")).toBe(`sh "${abs}" tool.pre`);
    expect(cmd("PostToolUse")).toBe(`sh "${abs}" tool.post`);
    expect(cmd("Stop")).toBe(`sh "${abs}" agent.stopped`);
    expect(cmd("SubagentStop")).toBe(`sh "${abs}" agent.subagent-stopped`);
    expect(handlerType("SessionStart")).toBe("command");
  });

  test("registers exactly the real Codex event set (PascalCase, no fictional names)", async () => {
    const worktree = join(dir, "wt-events");
    mkdirSync(worktree, { recursive: true });
    await installInto(worktree);
    const cfg = await readConfig(worktree);
    expect(Object.keys(cfg.hooks).sort()).toEqual([
      "PostToolUse",
      "PreToolUse",
      "SessionStart",
      "Stop",
      "SubagentStop",
      "UserPromptSubmit",
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

  test("registers the PR-ready gate as a SECOND PreToolUse matcher group scoped to Bash", async () => {
    const worktree = join(dir, "wt-gate");
    mkdirSync(worktree, { recursive: true });
    await installInto(worktree);
    const cfg = await readConfig(worktree);
    const groups = cfg.hooks.PreToolUse!;
    expect(groups).toHaveLength(2);
    // First group stays the universal heartbeat (no matcher, tool.pre).
    expect(groups[0]!.matcher).toBeUndefined();
    expect(groups[0]!.hooks[0]!.command).toBe(
      `sh "${join(worktree, ".middle/hooks/hook.sh")}" tool.pre`,
    );
    // Second group is the Bash-scoped blocking gate.
    expect(groups[1]!.matcher).toBe("Bash");
    expect(groups[1]!.hooks[0]!.command).toBe(
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

  test("symlinks the operator's auth.json into the worktree CODEX_HOME", async () => {
    const operatorHome = join(dir, "operator-codex");
    mkdirSync(operatorHome, { recursive: true });
    writeFileSync(join(operatorHome, "auth.json"), JSON.stringify({ tokens: "x" }));
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = operatorHome;
    try {
      const worktree = join(dir, "wt-auth");
      mkdirSync(worktree, { recursive: true });
      await installInto(worktree);
      const dest = join(worktree, ".codex", "auth.json");
      expect(lstatSync(dest).isSymbolicLink()).toBe(true);
      expect(readlinkSync(dest)).toBe(join(operatorHome, "auth.json"));
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
  });

  test("does not throw or create a link when the operator has no auth.json", async () => {
    const operatorHome = join(dir, "operator-empty");
    mkdirSync(operatorHome, { recursive: true });
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = operatorHome;
    try {
      const worktree = join(dir, "wt-noauth");
      mkdirSync(worktree, { recursive: true });
      await installInto(worktree); // must not throw
      expect(() => lstatSync(join(worktree, ".codex", "auth.json"))).toThrow();
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
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
    expect(detectNeedsLogin("Codex CLI v0.133.0")).toBe(false);
    expect(detectNeedsLogin("")).toBe(false);
  });
});

describe("detectHooksTrustPrompt", () => {
  test("matches the real 'Hooks need review' dialog text", () => {
    const pane = [
      "  Hooks need review",
      "  3 hooks are new or changed.",
      "  Hooks can run outside the sandbox after you trust them.",
      "› 1. Review hooks",
      "  2. Trust all and continue",
      "  3. Continue without trusting (hooks won't run)",
    ].join("\n");
    expect(detectHooksTrustPrompt(pane)).toBe(true);
  });

  test("does not match a normal pane or the directory-trust dialog", () => {
    expect(detectHooksTrustPrompt("> ")).toBe(false);
    expect(detectHooksTrustPrompt("Do you trust the contents of this directory?")).toBe(false);
  });
});

describe("detectDirTrustPrompt", () => {
  test("matches the real first-run directory-trust dialog text", () => {
    const pane = [
      "> You are in /home/u/wt",
      "  Do you trust the contents of this directory? Working with untrusted contents...",
      "› 1. Yes, continue",
      "  2. No, quit",
    ].join("\n");
    expect(detectDirTrustPrompt(pane)).toBe(true);
  });

  test("does not match a normal pane or the hooks-trust dialog", () => {
    expect(detectDirTrustPrompt("> ")).toBe(false);
    expect(detectDirTrustPrompt("Hooks need review")).toBe(false);
  });
});

describe("detectReadyForInput", () => {
  test("matches the live composer-ready welcome banner (codex 0.133.0)", () => {
    // Captured off a real codex 0.133.0 launch, right after the boot dialogs cleared.
    const pane = [
      "╭───────────────────────────────────────╮",
      "│ >_ OpenAI Codex (v0.133.0)            │",
      "│                                       │",
      "│ model:     gpt-5.5   /model to change │",
      "│ directory: /tmp/worktree              │",
      "╰───────────────────────────────────────╯",
      "› Find and fix a bug in @filename",
      "  gpt-5.5 default · /tmp/worktree",
    ].join("\n");
    expect(detectReadyForInput(pane)).toBe(true);
  });

  test("does not match a boot dialog (so a dialog is answered before we treat it as ready)", () => {
    expect(detectReadyForInput("> ")).toBe(false);
    expect(
      detectReadyForInput(["  Hooks need review", "  2. Trust all and continue"].join("\n")),
    ).toBe(false);
    expect(detectReadyForInput("Do you trust the contents of this directory?")).toBe(false);
  });
});

describe("startsSessionOnFirstPrompt", () => {
  test("codex sets the prompt-triggered-session flag (it fires no SessionStart until a prompt)", () => {
    expect(codexAdapter.startsSessionOnFirstPrompt).toBe(true);
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
