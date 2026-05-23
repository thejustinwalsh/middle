// @middle/adapter-claude — implements AgentAdapter for the Claude CLI.
import type { AgentAdapter } from "@middle/core";
import { capturePane, sendKeys } from "@middle/core";
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
const TRUST_PROMPT_RE =
  /do you trust|trust the files|trust this (folder|directory|workspace)|yes,?\s*i trust/i;
const NEEDS_LOGIN_RE =
  /please\s+(?:run\s+|use\s+)?(?:claude\s+)?\/?(?:login|sign[ -]?in)|not\s+(?:logged\s+in|authenticated|signed\s+in)|welcome\s+to\s+claude\s+code.*sign|invalid\s+(?:api\s+key|credentials)/i;

/** Whether a captured pane shows Claude's bypass-mode confirmation prompt. */
export function detectBypassPrompt(paneContent: string): boolean {
  return BYPASS_PROMPT_RE.test(paneContent);
}

/** Whether a captured pane shows the first-run "do you trust this folder?" dialog. */
export function detectTrustPrompt(paneContent: string): boolean {
  return TRUST_PROMPT_RE.test(paneContent);
}

/** Whether a captured pane shows a "you need to log in" message. */
export function detectNeedsLogin(paneContent: string): boolean {
  return NEEDS_LOGIN_RE.test(paneContent);
}

/** Long polling window — covers Claude's slowest boot up to launchTimeout. */
const BOOT_DETECT_TIMEOUT_MS = 90_000;
const BOOT_POLL_INTERVAL_MS = 200;

async function logPaneTail(sessionName: string, tag: string, label: string): Promise<void> {
  const pane = await capturePane(sessionName);
  const tail = (pane ?? "<capture failed>").replace(/\s+/g, " ").trim().slice(-300);
  console.error(`[${tag}] ${label}: "${tail}"`);
}

/**
 * Pre-SessionStart boot driving. Runs in parallel with `awaitSessionStart`
 * because Claude does not fire SessionStart until past its boot dialogs, which
 * appear in sequence on a fresh worktree:
 *
 *   1. **Folder-trust** ("Do you trust the files in this folder?") — first-run
 *      gate for any directory Claude hasn't seen. Default cursor is option 1
 *      ("Yes, I trust"), so we press `1` then Enter to select it explicitly.
 *   2. **Bypass-mode** ("Bypass Permissions mode … accept?") — default cursor
 *      is option 1 ("No, exit"), so we press Down to reach option 2 ("Yes, I
 *      accept") then Enter.
 *
 * We poll-and-answer each as it appears (each at most once), and throw on a
 * login screen so `mm dispatch` fails fast with a useful message rather than
 * hanging on the 90s SessionStart timeout.
 */
async function enterAutoMode(opts: { sessionName: string }): Promise<void> {
  const tag = `claude:${opts.sessionName}`;
  const deadline = Date.now() + BOOT_DETECT_TIMEOUT_MS;
  let trustAnswered = false;
  let bypassAnswered = false;

  while (Date.now() < deadline) {
    const pane = await capturePane(opts.sessionName);
    if (pane === null) {
      console.error(`[${tag}] enterAutoMode: capture-pane failed (session gone) — stopping`);
      return;
    }

    if (detectNeedsLogin(pane)) {
      throw new Error(
        "claude is not authenticated — run `claude` interactively in a normal terminal to sign in, then retry the dispatch",
      );
    }

    if (!trustAnswered && detectTrustPrompt(pane)) {
      console.error(`[${tag}] folder-trust dialog detected — selecting "Yes, I trust" (1, Enter)`);
      await Bun.sleep(200);
      await sendKeys(opts.sessionName, ["1"]);
      await Bun.sleep(100);
      await sendKeys(opts.sessionName, ["Enter"]);
      trustAnswered = true;
      await Bun.sleep(400);
      await logPaneTail(opts.sessionName, tag, "after trust answer");
      continue;
    }

    if (!bypassAnswered && detectBypassPrompt(pane)) {
      console.error(`[${tag}] bypass-mode dialog detected — selecting "Yes, I accept" (Down, Enter)`);
      await Bun.sleep(200);
      await sendKeys(opts.sessionName, ["Down", "Enter"], { delayBetweenMs: 100 });
      bypassAnswered = true;
      await Bun.sleep(400);
      await logPaneTail(opts.sessionName, tag, "after bypass answer");
      continue;
    }

    await Bun.sleep(BOOT_POLL_INTERVAL_MS);
  }
  console.error(`[${tag}] enterAutoMode: boot-dialog window (${BOOT_DETECT_TIMEOUT_MS}ms) elapsed`);
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
