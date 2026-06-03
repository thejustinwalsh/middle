/**
 * @packageDocumentation
 * @module @middle/adapter-codex
 *
 * The `AgentAdapter` implementation for the Codex CLI: launch command, auto-mode
 * confirmation, transcript reads, stop classification, and rate-limit detection.
 * Mirrors the Claude adapter; the per-CLI differences (worktree-local
 * `CODEX_HOME`, the `.codex/config.toml` `[hooks]` block, the JSONL rollout
 * transcript format, and structured rate-limit reads) are isolated here behind
 * the shared interface.
 *
 * Codex 0.133.0's hooks turn out to be modelled on Claude Code's — same
 * PascalCase event names, same payload fields, same `Bash` shell-tool name —
 * read off the binary and confirmed firing on a live interactive run.
 *
 * Public surface:
 * - `codexAdapter` — the `AgentAdapter` the dispatcher consumes
 * - `detectNeedsLogin`, `detectHooksTrustPrompt`, `detectDirTrustPrompt`, `detectReadyForInput` — pane probes
 *
 * Where things live:
 * - `index.ts` — the adapter object + boot-dialog driver (`enterAutoMode`)
 * - `classify.ts` — stop classification + structured rate-limit detection
 * - `hooks.ts` — `.codex/config.toml` hook installation + auth symlink
 * - `prompt.ts` — the launch prompt text
 * - `transcript.ts` — rollout-path resolution + state reads
 *
 * Gotchas:
 * - Auto mode is config-driven (`approval_policy = "never"` in
 *   `.codex/config.toml`), so there are no approval dialogs — but interactive
 *   codex DOES show two boot dialogs `enterAutoMode` must answer: a first-run
 *   directory-trust dialog (pre-empted by `[projects] trust_level = "trusted"`
 *   in the config, answered too as defense-in-depth) and a **hooks-trust**
 *   dialog ("Hooks need review"). Hooks only fire after "Trust all and continue"
 *   — `--dangerously-bypass-hook-trust` does NOT suppress it interactively.
 * - `buildLaunchCommand` sets `CODEX_HOME=<worktree>/.codex`; that repoints all
 *   codex state (auth, caches, sqlite, sessions) at the worktree, so `installHooks`
 *   symlinks the operator's `auth.json` in.
 * - Codex creates no session — and fires no `SessionStart` — until the first
 *   prompt is submitted, so the adapter sets `startsSessionOnFirstPrompt: true`
 *   and the dispatcher sends the prompt *before* awaiting the ready hook.
 *   `enterAutoMode` resolves on the composer-ready banner (`detectReadyForInput`)
 *   so that prompt-first send is not stalled to the boot-window deadline.
 *
 * claude-md: false
 */
import { join } from "node:path";
import type { AgentAdapter } from "@middle/core";
import { capturePane, sendKeys } from "@middle/core";
import { classifyStop, detectRateLimit } from "./classify.ts";
import { installHooks } from "./hooks.ts";
import { buildPromptText } from "./prompt.ts";
import { readTranscriptState, resolveTranscriptPath } from "./transcript.ts";

const NEEDS_LOGIN_RE =
  /please\s+(?:run\s+)?(?:codex\s+)?(?:login|sign[ -]?in)|not\s+(?:logged\s+in|authenticated|signed\s+in)|set\s+openai_api_key|invalid\s+(?:api\s+key|credentials)/i;

const HOOKS_TRUST_RE = /hooks\s+need\s+review|trust\s+all\s+and\s+continue|hooks\s+can\s+run/i;

const DIR_TRUST_RE =
  /do\s+you\s+trust\s+the\s+(?:files|contents)\s+(?:in|of)\s+this\s+(?:folder|directory|workspace)|trust(?:ing)?\s+the\s+directory/i;

// The interactive composer's welcome banner ("│ >_ OpenAI Codex (vX.Y.Z) │").
// It renders only AFTER every boot dialog is cleared, so its presence is a
// positive "ready for the first prompt" signal — captured live off codex
// 0.133.0 (it appears whether a dialog was answered or the home was already
// trusted). The dialog probes are checked before this, and a dialog screen
// never shows the banner anyway, so a dialog is always answered first.
const READY_RE = /OpenAI Codex\s*\(v/i;

/** Whether a captured pane shows a "you need to log in" message. */
export function detectNeedsLogin(paneContent: string): boolean {
  return NEEDS_LOGIN_RE.test(paneContent);
}

/**
 * Whether a captured pane shows the "Hooks need review" trust dialog — the gate
 * that withholds enabled hooks until trusted. Answered by selecting "Trust all
 * and continue".
 */
export function detectHooksTrustPrompt(paneContent: string): boolean {
  return HOOKS_TRUST_RE.test(paneContent);
}

/** Whether a captured pane shows the first-run "do you trust this directory?" dialog. */
export function detectDirTrustPrompt(paneContent: string): boolean {
  return DIR_TRUST_RE.test(paneContent);
}

/**
 * Whether a captured pane shows the interactive composer ready for the first
 * prompt — the welcome banner that renders once every boot dialog is cleared.
 * `enterAutoMode` returns on this so the prompt-first launch order sends the
 * prompt the moment codex is ready, instead of waiting out the boot window.
 */
export function detectReadyForInput(paneContent: string): boolean {
  return READY_RE.test(paneContent);
}

/** Long polling window — covers Codex's boot before SessionStart fires. */
const BOOT_DETECT_TIMEOUT_MS = 90_000;
const BOOT_POLL_INTERVAL_MS = 200;

/**
 * Pre-SessionStart boot driving. Runs in parallel with the SessionStart wait,
 * because interactive Codex does not fire `SessionStart` until past its boot
 * dialogs. On a fresh worktree two can appear, in sequence:
 *
 *   1. **Directory-trust** ("Do you trust the contents of this directory?") —
 *      pre-empted by `[projects."<worktree>"] trust_level = "trusted"` in the
 *      config so it normally does not show, but we answer it ("1. Yes,
 *      continue") if it does, as defense-in-depth.
 *   2. **Hooks-trust** ("Hooks need review") — the load-bearing one. Hooks (and
 *      thus the heartbeat) only fire after selecting "2. Trust all and continue".
 *      `--dangerously-bypass-hook-trust` does NOT suppress this interactively.
 *
 * We poll-and-answer each as it appears (each at most once), and throw on a
 * login screen so `mm dispatch` fails fast with a useful message rather than
 * hanging on the SessionStart timeout.
 *
 * Resolves the instant the composer is ready ({@link detectReadyForInput}) —
 * not at the end of the boot window. That's load-bearing for the prompt-first
 * launch order ({@link AgentAdapter.startsSessionOnFirstPrompt}): the dispatcher
 * `await`s this before sending the first prompt (codex fires no `SessionStart`
 * until then), so a return that lagged to the full timeout would stall every
 * launch. The boot-window deadline remains only as a last-resort fallback.
 */
async function enterAutoMode(opts: { sessionName: string }): Promise<void> {
  const tag = `codex:${opts.sessionName}`;
  const deadline = Date.now() + BOOT_DETECT_TIMEOUT_MS;
  let dirTrustAnswered = false;
  let hooksTrustAnswered = false;

  while (Date.now() < deadline) {
    const pane = await capturePane(opts.sessionName);
    if (pane === null) {
      console.error(`[${tag}] enterAutoMode: capture-pane failed (session gone) — stopping`);
      return;
    }

    if (detectNeedsLogin(pane)) {
      throw new Error(
        "codex is not authenticated — run `codex login` (or set OPENAI_API_KEY) in a normal terminal, then retry the dispatch",
      );
    }

    if (!dirTrustAnswered && detectDirTrustPrompt(pane)) {
      console.error(
        `[${tag}] directory-trust dialog detected — selecting "Yes, continue" (1, Enter)`,
      );
      await Bun.sleep(200);
      await sendKeys(opts.sessionName, ["1", "Enter"], { delayBetweenMs: 100 });
      dirTrustAnswered = true;
      await Bun.sleep(400);
      continue;
    }

    if (!hooksTrustAnswered && detectHooksTrustPrompt(pane)) {
      console.error(
        `[${tag}] hooks-trust dialog detected — selecting "Trust all and continue" (2, Enter)`,
      );
      await Bun.sleep(200);
      await sendKeys(opts.sessionName, ["2", "Enter"], { delayBetweenMs: 100 });
      hooksTrustAnswered = true;
      await Bun.sleep(400);
      continue;
    }

    // Composer is up and every dialog is cleared — codex is ready for the first
    // prompt. Return now so the prompt-first launch order can drive it, instead
    // of idling to the boot-window deadline. Safe vs the dialog probes above:
    // they run first (and `continue`), and a dialog screen never renders this
    // banner — so a still-open dialog is always answered before we treat the
    // pane as ready. The once-only `*Answered` guards mean a dropped keystroke
    // isn't re-sent; such a pane simply never goes ready and falls through to
    // the deadline rather than risking double-input on a co-rendered banner.
    if (detectReadyForInput(pane)) {
      console.error(`[${tag}] composer ready — boot dialogs cleared, ready for first prompt`);
      return;
    }

    await Bun.sleep(BOOT_POLL_INTERVAL_MS);
  }
  console.error(
    `[${tag}] enterAutoMode: boot-dialog window (${BOOT_DETECT_TIMEOUT_MS}ms) elapsed without a ready signal`,
  );
}

/**
 * The Codex CLI agent adapter. Implements {@link AgentAdapter} for the
 * dispatcher: builds the interactive launch command (`codex`, no `exec`; auto
 * mode + sandbox + hooks set in the worktree-local `.codex/config.toml` via
 * `CODEX_HOME`), answers the boot trust dialogs, reads the JSONL rollout
 * transcript for stop classification, and detects rate-limit and needs-login
 * states.
 */
export const codexAdapter: AgentAdapter = {
  name: "codex",
  readyEvent: "session.started",
  // codex creates no session — and fires no SessionStart — until the first
  // prompt is submitted, so the dispatcher must send the prompt before awaiting
  // the ready hook. See AgentAdapter.startsSessionOnFirstPrompt.
  startsSessionOnFirstPrompt: true,
  installHooks,
  buildLaunchCommand(opts) {
    // Interactive — no `exec`, no prompt. approval_policy/sandbox_mode/hooks live
    // in <worktree>/.codex/config.toml (written by installHooks). CODEX_HOME
    // points codex at that worktree-local home so the config is actually loaded;
    // installHooks symlinks auth.json in so the repointed home stays signed in.
    // Env is injected by tmux at spawn time.
    return {
      argv: ["codex"],
      env: {
        CODEX_HOME: join(opts.worktree, ".codex"),
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
  detectRateLimit,
};
