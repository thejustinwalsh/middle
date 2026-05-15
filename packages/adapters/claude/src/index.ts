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

/**
 * No-op: the launch flag above puts the session in auto mode at start time, so
 * there is nothing keystroke-cyclable left to do when `SessionStart` fires.
 * The method stays on the interface as the per-CLI hook for any adapter whose
 * auto mode IS a post-launch keystroke gesture.
 */
async function enterAutoMode(_opts: { sessionName: string }): Promise<void> {
  // intentionally empty — see PERMISSION_MODE on buildLaunchCommand
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
