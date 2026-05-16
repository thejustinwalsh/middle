// @middle/adapter-claude — implements AgentAdapter for the Claude CLI.
import type { AgentAdapter } from "@middle/core";
import { capturePane, pollPaneFor, sendKeys } from "@middle/core";
import { classifyStop } from "./classify.ts";
import { installHooks } from "./hooks.ts";
import { buildPromptText } from "./prompt.ts";
import { readTranscriptState, resolveTranscriptPath } from "./transcript.ts";

/**
 * `--dangerously-skip-permissions` is the auto-mode flag — runtime-equivalent
 * to bypassPermissions, but still pops a one-time "are you sure?" warning at
 * boot. `enterAutoMode` dismisses it.
 */
const AUTO_MODE_FLAG = "--dangerously-skip-permissions";

const BYPASS_PROMPT_RE = /bypass\s+permissions?|skip\s+permissions?|dangerously/i;
const NEEDS_LOGIN_RE =
  /please\s+(?:run\s+|use\s+)?(?:claude\s+)?\/?(?:login|sign[ -]?in)|not\s+(?:logged\s+in|authenticated|signed\s+in)|welcome\s+to\s+claude\s+code.*sign|invalid\s+(?:api\s+key|credentials)/i;

/** Whether a captured pane shows Claude's bypass-mode confirmation prompt. */
export function detectBypassPrompt(paneContent: string): boolean {
  return BYPASS_PROMPT_RE.test(paneContent);
}

/** Whether a captured pane shows a "you need to log in" message. */
export function detectNeedsLogin(paneContent: string): boolean {
  return NEEDS_LOGIN_RE.test(paneContent);
}

/** Long polling window — covers Claude's slowest boot up to launchTimeout. */
const BOOT_DETECT_TIMEOUT_MS = 90_000;

type BootOutcome = "bypass-prompt" | "needs-login";

/**
 * Pre-SessionStart boot polling. Runs in parallel with `awaitSessionStart`
 * because Claude does not fire SessionStart until past the bypass-mode
 * warning. Two outcomes drive action:
 *
 * - `bypass-prompt`: send Down + Enter (split with a 100ms delay so the menu
 *   has time to advance selection between keys) to select "Yes, I accept".
 *   Claude proceeds and fires SessionStart shortly after.
 * - `needs-login`: throw a clean error so `mm dispatch` exits with a useful
 *   "claude is not authenticated" message instead of hanging on a 90s
 *   SessionStart timeout.
 */
async function enterAutoMode(opts: { sessionName: string }): Promise<void> {
  const tag = `claude:${opts.sessionName}`;
  const outcome = await pollPaneFor<BootOutcome>(
    opts.sessionName,
    (pane) => {
      if (detectNeedsLogin(pane)) return "needs-login";
      if (detectBypassPrompt(pane)) return "bypass-prompt";
      return null;
    },
    { timeoutMs: BOOT_DETECT_TIMEOUT_MS, pollIntervalMs: 200, tag },
  );

  if (outcome === "needs-login") {
    throw new Error(
      "claude is not authenticated — run `claude` interactively in a normal terminal to sign in, then retry the dispatch",
    );
  }
  if (outcome === "bypass-prompt") {
    console.error(`[${tag}] bypass prompt detected — settling then Down then Enter`);
    await Bun.sleep(200);
    await sendKeys(opts.sessionName, ["Down", "Enter"], { delayBetweenMs: 100 });
    // Post-keystroke capture confirms whether the menu actually advanced.
    await Bun.sleep(300);
    const after = await capturePane(opts.sessionName);
    const afterTail = (after ?? "<capture failed>").replace(/\s+/g, " ").trim().slice(-300);
    console.error(`[${tag}] post-keystroke pane tail: "${afterTail}"`);
  }
  // outcome null: neither prompt nor login screen appeared. SessionStart should
  // already have fired (or be about to). enterAutoMode has nothing else to do.
}

export const claudeAdapter: AgentAdapter = {
  name: "claude",
  readyEvent: "session.started",
  installHooks,
  buildLaunchCommand(opts) {
    // Interactive — no `-p`, no prompt. `--dangerously-skip-permissions`
    // engages auto mode AND suppresses the API-permission gate (the bypass
    // confirmation TUI is separate, dismissed via enterAutoMode). Env is
    // injected by tmux at spawn time.
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
