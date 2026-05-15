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
 *
 * A non-zero exit from `tmux send-keys` (missing session, tmux not on PATH)
 * throws so `launchAndDrive`'s catch can kill the session and compensate —
 * otherwise the workflow would silently proceed to send the prompt into a
 * session that never entered auto mode and never reaches `Stop`.
 */
async function enterAutoMode(opts: { sessionName: string }): Promise<void> {
  const proc = Bun.spawn(["tmux", "send-keys", "-t", opts.sessionName, "S-Tab", "S-Tab"], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(
      `enterAutoMode: tmux send-keys to "${opts.sessionName}" failed (exit ${exitCode}): ${stderr.trim()}`,
    );
  }
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
