import type { HookPayload, NormalizedEvent } from "./events.ts";

/**
 * The single interface every CLI agent sits behind. middle dispatches every
 * agent as an interactive CLI session inside tmux — there is no headless mode.
 * The adapter abstracts the per-CLI launch command, prompt-delivery text, how
 * to enter auto mode, how to locate and read the on-disk transcript, and how to
 * classify a turn boundary. Source of truth: build spec → "Adapter interface".
 */
export interface AgentAdapter {
  readonly name: string; // 'claude' | 'codex' | ...

  /** Write hook config + any per-CLI setup into the worktree. */
  installHooks(opts: InstallHookOpts): Promise<void>;

  /** Build the INTERACTIVE launch command. tmux runs this; it takes no prompt. */
  buildLaunchCommand(opts: LaunchOpts): {
    argv: string[];
    env: Record<string, string>;
  };

  /**
   * The literal text to send-keys into the session to start or continue the
   * agent — includes the `@`-reference to the on-disk prompt file.
   */
  buildPromptText(opts: {
    promptFile: string; // path, relative to the worktree
    kind: "initial" | "resume" | "answer";
  }): string;

  /** Put the ready session into auto mode — a launch flag or post-ready keystrokes. */
  enterAutoMode(opts: { sessionName: string }): Promise<void>;

  /** The normalized event that signals the CLI is ready for input. */
  readonly readyEvent: NormalizedEvent;

  /** Locate the on-disk session transcript from the ready/session hook payload. */
  resolveTranscriptPath(payload: HookPayload): string;

  /** Read activity, state, and context/token usage from the transcript. */
  readTranscriptState(transcriptPath: string): TranscriptState;

  /** Classify the agent's state at a Stop hook. */
  classifyStop(opts: {
    payload: HookPayload;
    transcriptPath: string;
    sentinelPresent: boolean;
  }): StopClassification;

  /** Optional: detect a rate-limit message in a Stop-hook payload or transcript. */
  detectRateLimit?(opts: {
    payload: HookPayload;
    transcriptPath: string;
  }): RateLimitDetection | null;
}

export type InstallHookOpts = {
  worktree: string;
  hookScriptPath: string; // .middle/hooks/hook.sh in the worktree
  dispatcherUrl: string; // http://127.0.0.1:8822
  sessionName: string;
  sessionToken: string; // HMAC token for hook auth
  epicNumber: number; // the Epic (or standalone issue) being dispatched
};

export type LaunchOpts = {
  worktree: string;
  sessionName: string;
  sessionToken: string;
  envOverrides?: Record<string, string>;
};

export type TranscriptState = {
  lastActivity: string; // ISO
  contextTokens: number; // for the context-overflow monitor
  turnCount: number;
  lastToolUse: string | null;
};

export type StopClassification =
  | { kind: "done" } // agent marked the PR ready
  | { kind: "asked-question"; sentinelPath: string }
  | { kind: "rate-limited"; resetAt: string /* ISO */ }
  | { kind: "bare-stop" } // stopped, no sentinel, not done
  | { kind: "failed"; reason: string };

export type RateLimitDetection = {
  resetAt: string;
  source: "stop-hook" | "transcript";
};
