// @middle/adapter-claude — implements AgentAdapter for the Claude CLI.
import type { AgentAdapter } from "@middle/core";
import { classifyStop } from "./classify.ts";
import { installHooks } from "./hooks.ts";
import { buildPromptText } from "./prompt.ts";
import { readTranscriptState, resolveTranscriptPath } from "./transcript.ts";

/**
 * `--dangerously-skip-permissions` is the explicit "skip all checks AND the
 * one-time bypass-mode confirmation" flag. `--permission-mode bypassPermissions`
 * has the same runtime semantics but still pops a one-time UI confirmation when
 * the session boots — fine for a human, fatal for autonomous dispatch (the
 * agent would hang on the prompt because middle has no readiness gate to
 * answer it). The keystroke path (`S-Tab S-Tab`) is the spec's documented
 * fallback if Claude ever drops this flag from interactive mode.
 */
const AUTO_MODE_FLAG = "--dangerously-skip-permissions";

/** Marker text that identifies Claude's one-time bypass-mode confirmation. */
const BYPASS_PROMPT_RE = /bypass\s+permissions?|skip\s+permissions?|dangerously/i;

/** Whether a captured pane shows Claude's bypass-mode confirmation prompt. */
export function detectBypassPrompt(paneContent: string): boolean {
  return BYPASS_PROMPT_RE.test(paneContent);
}

// Polls for the duration of the launch window — SessionStart is gated on the
// warning being dismissed, so this poller needs to outlast Claude's slowest
// boot. Caller fires this in parallel with awaitSessionStart; whichever happens
// first proceeds the workflow.
const BYPASS_DETECT_TIMEOUT_MS = 90_000;
const BYPASS_POLL_INTERVAL_MS = 200;

/**
 * Poll `tmux capture-pane` for up to a few seconds looking for the bypass-mode
 * confirmation that Claude pops at first boot — current Claude still pops it
 * even with `--dangerously-skip-permissions`. On match: send Down + Enter to
 * select "Yes, I accept". If the session disappears (capture-pane fails) we
 * exit immediately so a missing session never blocks the workflow. If the
 * prompt never appears within the window we return silently — no destructive
 * keystrokes are sent.
 */
async function enterAutoMode(opts: { sessionName: string }): Promise<void> {
  const deadline = Date.now() + BYPASS_DETECT_TIMEOUT_MS;
  const tag = `[claude:${opts.sessionName}]`;
  let iter = 0;
  while (Date.now() < deadline) {
    iter++;
    const pane = await capturePane(opts.sessionName);
    if (pane === null) {
      console.error(`${tag} enterAutoMode iter ${iter}: capture-pane failed, exiting`);
      return;
    }
    const preview = pane
      .replace(/\s+/g, " ")
      .trim()
      .slice(-300); // tail; the prompt is the last thing rendered
    const matched = detectBypassPrompt(pane);
    console.error(
      `${tag} enterAutoMode iter ${iter}: paneLen=${pane.length} match=${matched} tail="${preview}"`,
    );
    if (matched) {
      console.error(`${tag} sending Down+Enter to accept bypass mode`);
      await sendKeys(opts.sessionName, ["Down", "Enter"]);
      return;
    }
    await Bun.sleep(BYPASS_POLL_INTERVAL_MS);
  }
  console.error(
    `${tag} enterAutoMode: bypass prompt never matched within ${BYPASS_DETECT_TIMEOUT_MS}ms`,
  );
}

async function capturePane(sessionName: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["tmux", "capture-pane", "-p", "-t", sessionName], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return exitCode === 0 ? stdout : null;
  } catch {
    return null;
  }
}

async function sendKeys(sessionName: string, keys: string[]): Promise<void> {
  try {
    const proc = Bun.spawn(["tmux", "send-keys", "-t", sessionName, ...keys], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  } catch {
    // best-effort: answering the bypass prompt is recoverable. If it fails the
    // workflow proceeds anyway; classifyStop's downstream signals will catch
    // a session that never reached an interactive ready state.
  }
}

export const claudeAdapter: AgentAdapter = {
  name: "claude",
  readyEvent: "session.started",
  installHooks,
  buildLaunchCommand(opts) {
    // Interactive — no `-p`, no prompt. `--dangerously-skip-permissions`
    // engages auto mode AND suppresses the one-time bypass-mode confirmation
    // prompt at boot (which `--permission-mode bypassPermissions` would still
    // pop — fatal for autonomous dispatch with no readiness gate to answer
    // it). Env is injected by tmux at spawn time.
    return {
      argv: ["claude", AUTO_MODE_FLAG],
      env: {
        MIDDLE_SESSION: opts.sessionName,
        MIDDLE_SESSION_TOKEN: opts.sessionToken,
        ...opts.envOverrides,
      },
    };
  },
  buildPromptText,
  enterAutoMode,
  resolveTranscriptPath,
  readTranscriptState,
  classifyStop,
};
