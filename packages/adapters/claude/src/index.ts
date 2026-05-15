// @middle/adapter-claude — implements AgentAdapter for the Claude CLI.
import type { AgentAdapter } from "@middle/core";
import { classifyStop } from "./classify.ts";
import { installHooks } from "./hooks.ts";
import { buildPromptText } from "./prompt.ts";
import { readTranscriptState, resolveTranscriptPath } from "./transcript.ts";

/**
 * Auto mode is set at launch time via `--permission-mode bypassPermissions`.
 * This is the spec's "launch flag if one is honored in interactive mode" path,
 * preferred over the `S-Tab S-Tab` keystroke fallback because the latter
 * depends on the mode-cycle order — which has shifted across Claude versions
 * (`default → acceptEdits → plan → bypassPermissions` in current builds, so
 * two Shift-Tabs lands on *plan mode*, not bypass) — and on the TUI being
 * input-ready immediately after `SessionStart`, which has no readiness gate.
 */
const PERMISSION_MODE = "bypassPermissions";

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
    // Interactive — no `-p`, no prompt. `--permission-mode` engages auto mode
    // at launch (replaces the legacy `S-Tab S-Tab` keystroke cycle). Env is
    // injected by tmux at spawn time.
    return {
      argv: ["claude", "--permission-mode", PERMISSION_MODE],
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
