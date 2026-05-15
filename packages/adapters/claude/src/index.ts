// @middle/adapter-claude — implements AgentAdapter for the Claude CLI.
import type { AgentAdapter } from "@middle/core";
import { classifyStop } from "./classify.ts";
import { installHooks } from "./hooks.ts";
import { buildPromptText } from "./prompt.ts";
import { readTranscriptState, resolveTranscriptPath } from "./transcript.ts";

/**
 * Bring the ready session into auto mode. Claude's interactive mode honors no
 * launch flag for this, so the guaranteed path is two Shift-Tab keystrokes sent
 * into the live tmux session. The adapter shells out to `tmux` directly rather
 * than depending on the dispatcher's richer helper module — entering auto mode
 * is intrinsically a per-CLI keystroke concern the adapter owns.
 */
async function enterAutoMode(opts: { sessionName: string }): Promise<void> {
  const proc = Bun.spawn(["tmux", "send-keys", "-t", opts.sessionName, "S-Tab", "S-Tab"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

export const claudeAdapter: AgentAdapter = {
  name: "claude",
  readyEvent: "session.started",
  installHooks,
  buildLaunchCommand(opts) {
    // Interactive — no `-p`, no prompt. Env is injected by tmux at spawn time.
    return {
      argv: ["claude"],
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
