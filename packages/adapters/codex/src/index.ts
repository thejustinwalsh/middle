/**
 * @packageDocumentation
 * @module @middle/adapter-codex
 *
 * The `AgentAdapter` implementation for the Codex CLI: launch command, auto-mode
 * confirmation, transcript reads, stop classification, and rate-limit detection.
 * Mirrors the Claude adapter; the per-CLI differences (config-driven auto mode,
 * the `.codex/config.toml` `[hooks]` block, the rollout transcript format, and
 * the rate-limit pattern) are isolated here behind the shared interface.
 *
 * Public surface:
 * - `codexAdapter` — the `AgentAdapter` the dispatcher consumes
 * - `detectNeedsLogin` — pane probe for a not-authenticated session
 *
 * Where things live:
 * - `index.ts` — the adapter object + auto-mode confirmation (`enterAutoMode`)
 * - `classify.ts` — stop classification + rate-limit detection
 * - `hooks.ts` — `.codex/config.toml` hook installation
 * - `prompt.ts` — the launch prompt text
 * - `transcript.ts` — rollout-path resolution + state reads
 *
 * Gotchas:
 * - Auto mode is config-driven (`approval_policy = "never"` in `.codex/config.toml`),
 *   not a launch flag — so `enterAutoMode` sends no keystrokes; it only fails fast
 *   on a not-logged-in pane. Codex's observable bits (hook names, rollout format,
 *   rate-limit message, force-include syntax) are start-generous baselines pending
 *   live observation — see `planning/issues/60/decisions.md`.
 *
 * claude-md: false
 */
import type { AgentAdapter } from "@middle/core";
import { capturePane } from "@middle/core";
import { classifyStop, detectRateLimit } from "./classify.ts";
import { installHooks } from "./hooks.ts";
import { buildPromptText } from "./prompt.ts";
import { readTranscriptState, resolveTranscriptPath } from "./transcript.ts";

const NEEDS_LOGIN_RE =
  /please\s+(?:run\s+)?(?:codex\s+)?(?:login|sign[ -]?in)|not\s+(?:logged\s+in|authenticated|signed\s+in)|set\s+openai_api_key|invalid\s+(?:api\s+key|credentials)/i;

/** Whether a captured pane shows a "you need to log in" message. */
export function detectNeedsLogin(paneContent: string): boolean {
  return NEEDS_LOGIN_RE.test(paneContent);
}

/** Short window — covers Codex's boot before the startup hook fires. */
const BOOT_DETECT_TIMEOUT_MS = 90_000;
const BOOT_POLL_INTERVAL_MS = 200;

/**
 * Confirm the session is ready for auto operation. Unlike Claude — which must
 * dismiss folder-trust + bypass dialogs — Codex's auto mode comes entirely from
 * `.codex/config.toml` (`approval_policy = "never"`, `sandbox = "workspace-write"`),
 * so there are no approval dialogs to answer and no keystrokes to send. This
 * method's only job is to fail fast on a not-authenticated pane so a dispatch
 * against an unconfigured Codex surfaces a useful error instead of hanging on the
 * startup-hook timeout. It returns as soon as the pane looks normal (no login
 * prompt), or when the boot window elapses.
 *
 * NOTE (tightening point): if a live Codex turns out to show a first-run trust /
 * onboarding prompt, the keystroke handling for it is added here.
 */
async function enterAutoMode(opts: { sessionName: string }): Promise<void> {
  const tag = `codex:${opts.sessionName}`;
  const deadline = Date.now() + BOOT_DETECT_TIMEOUT_MS;

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
    // A non-empty, non-login pane means Codex has booted into its prompt; auto
    // mode is already in force via config, so there's nothing to send.
    if (pane.trim().length > 0) return;
    await Bun.sleep(BOOT_POLL_INTERVAL_MS);
  }
  console.error(`[${tag}] enterAutoMode: boot window (${BOOT_DETECT_TIMEOUT_MS}ms) elapsed`);
}

/**
 * The Codex CLI agent adapter. Implements {@link AgentAdapter} for the
 * dispatcher: builds the interactive launch command (`codex`, no `exec`; auto
 * mode + sandbox set in `.codex/config.toml`), confirms readiness, reads the
 * rollout transcript for stop classification, and detects rate-limit and
 * needs-login states.
 */
export const codexAdapter: AgentAdapter = {
  name: "codex",
  readyEvent: "session.started",
  installHooks,
  buildLaunchCommand(opts) {
    // Interactive — no `exec`, no prompt. approval_policy/sandbox live in
    // .codex/config.toml (written by installHooks), not the command line. Env is
    // injected by tmux at spawn time.
    return {
      argv: ["codex"],
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
  detectRateLimit,
};
