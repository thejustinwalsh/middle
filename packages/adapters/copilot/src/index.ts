/**
 * @packageDocumentation
 * @module @middle/adapter-copilot
 *
 * The `AgentAdapter` implementation for the GitHub Copilot CLI: launch command,
 * auto-mode + composer-ready boot driving, transcript reads, stop classification,
 * and rate-limit detection. The third adapter (after Claude + Codex), proving the
 * abstraction generalizes past a second CLI. The per-CLI differences — worktree-
 * local `COPILOT_HOME`, the `~/.copilot/hooks/*.json` config, camelCase +
 * string-encoded hook payloads, the `events.jsonl` transcript (path *derived*, not
 * handed over), and `sessionEnd`-as-turn-boundary — are isolated here behind the
 * shared interface.
 *
 * Copilot 1.0.54's hook surface is its OWN (not Claude-modelled like Codex's):
 * camelCase events (`sessionStart`/`userPromptSubmitted`/`preToolUse`/`postToolUse`/
 * `sessionEnd`/`errorOccurred`), no per-turn stop hook, and payloads that carry
 * `sessionId` (not `session_id`) and no `transcript_path`. All read off the live
 * binary (see `planning/issues/124/decisions.md`).
 *
 * Public surface:
 * - `copilotAdapter` — the `AgentAdapter` the dispatcher consumes
 * - `detectNeedsLogin`, `detectTrustPrompt`, `detectReadyForInput` — pane probes
 *
 * Where things live:
 * - `index.ts` — the adapter object + boot driver (`enterAutoMode`)
 * - `classify.ts` — stop classification + text-regex rate-limit detection
 * - `hooks.ts` — `~/.copilot` hook + config installation (no auth symlink — gh auth)
 * - `prompt.ts` — the launch prompt text
 * - `transcript.ts` — derived rollout-path resolution + `events.jsonl` reads
 *
 * Gotchas:
 * - Auto mode is the `--allow-all-tools` launch flag (+ `COPILOT_ALLOW_ALL`), and
 *   the worktree is pre-trusted via `config.json` `trustedFolders`, so no boot
 *   dialog normally appears; `enterAutoMode` returns on the composer-ready pane and
 *   throws fast on a needs-login screen.
 * - `buildLaunchCommand` sets `COPILOT_HOME=<worktree>/.copilot`; that repoints all
 *   copilot state (config, hooks, session-state) at the worktree. Auth is NOT
 *   repointed — Copilot signs in via `gh` (`~/.config/gh`), so no auth symlink is
 *   needed (unlike Codex).
 * - Copilot creates no session — and fires no `sessionStart` — until the first
 *   prompt is submitted (the live probe confirmed `userPromptSubmitted` precedes
 *   `sessionStart`, `source:"new"`), so the adapter sets
 *   `startsSessionOnFirstPrompt: true` and the dispatcher sends the prompt before
 *   awaiting the ready hook. `enterAutoMode` resolves on the composer-ready banner
 *   so that prompt-first send is not stalled to the boot deadline.
 * - There is NO per-turn stop hook; `sessionEnd → agent.stopped` is the turn
 *   boundary (see `hooks.ts`). The one seam the third adapter strains.
 *
 * claude-md: false
 */
import { join } from "node:path";
import type { AgentAdapter } from "@middle/core";
import { capturePane } from "@middle/core";
import { classifyStop, detectRateLimit } from "./classify.ts";
import { installHooks } from "./hooks.ts";
import { buildPromptText } from "./prompt.ts";
import { readTranscriptState, resolveTranscriptPath } from "./transcript.ts";

const NEEDS_LOGIN_RE =
  /please\s+(?:run\s+)?(?:copilot\s+)?(?:\/)?(?:login|sign[ -]?in)|not\s+(?:logged\s+in|authenticated|signed\s+in)|gh\s+auth\s+login|authentication\s+required/i;

// Defense-in-depth: a first-run folder-trust dialog. Pre-empted by
// `trustedFolders` in config.json (the probe saw no dialog), so this is a
// detect-and-log signal — we don't blind-press a key whose layout we haven't
// confirmed, which could mis-answer; pre-trust is the mechanism.
const TRUST_PROMPT_RE =
  /do you trust|trust the (?:files|contents)|trust this (?:folder|directory|workspace)/i;

// The interactive composer ready for input. Copilot's idle footer hint
// ("/ commands · ? help") and the `❯` input prompt render only once the boot
// sequence is past — captured live off copilot 1.0.54. Matching either is a
// positive "ready for the first prompt" signal.
const READY_RE = /❯|\/\s*commands|·\s*\?\s*help|\?\s*help/;

/** Whether a captured pane shows a "you need to log in" message. */
export function detectNeedsLogin(paneContent: string): boolean {
  return NEEDS_LOGIN_RE.test(paneContent);
}

/** Whether a captured pane shows a first-run folder-trust dialog (pre-empted by `trustedFolders`). */
export function detectTrustPrompt(paneContent: string): boolean {
  return TRUST_PROMPT_RE.test(paneContent);
}

/**
 * Whether a captured pane shows the interactive composer ready for the first
 * prompt. `enterAutoMode` returns on this so the prompt-first launch order sends
 * the prompt the moment Copilot is ready, instead of waiting out the boot window.
 */
export function detectReadyForInput(paneContent: string): boolean {
  return READY_RE.test(paneContent);
}

/** Long polling window — covers Copilot's boot before the composer is ready. */
const BOOT_DETECT_TIMEOUT_MS = 90_000;
const BOOT_POLL_INTERVAL_MS = 200;

/**
 * Pre-prompt boot driving. Copilot fires no `sessionStart` until the first prompt,
 * so (like Codex) the dispatcher awaits this, THEN sends the prompt, THEN awaits
 * the ready hook. This polls the pane and:
 *   - throws on a login screen so `mm dispatch` fails fast with a useful message
 *     rather than feeding the prompt into a login prompt;
 *   - logs a folder-trust dialog if one appears despite the `trustedFolders`
 *     pre-trust (defense-in-depth visibility — no blind keypress);
 *   - returns the instant the composer is ready ({@link detectReadyForInput}),
 *     well before the boot deadline, which is load-bearing for the prompt-first
 *     order: a return that lagged to the full timeout would stall every launch.
 *
 * **Resolving means "the composer is ready" — the only success path.** Every
 * non-ready terminal exit throws so the caller can distinguish a ready session
 * from a dead/never-readied one: a vanished session (capture-pane returns null)
 * and an elapsed boot window both throw rather than resolving. Resolving on those
 * would make the caller send the prompt-first keystrokes into a session that
 * never reached the composer — the failure the third adapter's review surfaced.
 */
async function enterAutoMode(opts: { sessionName: string }): Promise<void> {
  const tag = `copilot:${opts.sessionName}`;
  const deadline = Date.now() + BOOT_DETECT_TIMEOUT_MS;
  let trustWarned = false;

  while (Date.now() < deadline) {
    const pane = await capturePane(opts.sessionName);
    if (pane === null) {
      throw new Error(
        `copilot session "${opts.sessionName}" disappeared (capture-pane failed) before reaching the ready-for-input composer`,
      );
    }

    if (detectNeedsLogin(pane)) {
      throw new Error(
        "copilot is not authenticated — run `copilot` (or `gh auth login`) in a normal terminal to sign in, then retry the dispatch",
      );
    }

    if (!trustWarned && detectTrustPrompt(pane)) {
      console.error(
        `[${tag}] a folder-trust dialog appeared despite trustedFolders pre-trust — relying on --allow-all-tools; if this stalls, pre-trust the worktree`,
      );
      trustWarned = true;
    }

    if (detectReadyForInput(pane)) {
      console.error(`[${tag}] composer ready — ready for first prompt`);
      return;
    }

    await Bun.sleep(BOOT_POLL_INTERVAL_MS);
  }
  throw new Error(
    `copilot session "${opts.sessionName}" did not reach the ready-for-input composer within the ${BOOT_DETECT_TIMEOUT_MS}ms boot window`,
  );
}

/**
 * The GitHub Copilot CLI agent adapter. Implements {@link AgentAdapter} for the
 * dispatcher: builds the interactive launch command (`copilot --allow-all-tools`,
 * no `-p`; auto mode via the flag + `COPILOT_ALLOW_ALL`, the worktree pre-trusted
 * and hooks registered in the worktree-local `.copilot` home via `COPILOT_HOME`),
 * returns on the composer-ready pane, derives + reads the `events.jsonl` rollout
 * for stop classification, and detects rate-limit and needs-login states.
 */
export const copilotAdapter: AgentAdapter = {
  name: "copilot",
  readyEvent: "session.started",
  // Copilot creates no session — and fires no sessionStart — until the first
  // prompt is submitted (live probe), so the dispatcher must send the prompt
  // before awaiting the ready hook. See AgentAdapter.startsSessionOnFirstPrompt.
  startsSessionOnFirstPrompt: true,
  installHooks,
  buildLaunchCommand(opts) {
    // Interactive — no `-p`, no prompt. `--allow-all-tools` engages auto mode (no
    // per-tool confirmation); COPILOT_ALLOW_ALL is belt-and-suspenders. COPILOT_HOME
    // points copilot at the worktree-local home so the config + hooks load; auth is
    // NOT repointed (copilot signs in via gh), so no auth symlink is needed. Any
    // gh token the operator exported is forwarded so a token-auth setup keeps
    // working under the repointed home. Env is injected by tmux at spawn time.
    const env: Record<string, string> = {
      COPILOT_HOME: join(opts.worktree, ".copilot"),
      COPILOT_ALLOW_ALL: "true",
      MIDDLE_SESSION: opts.sessionName,
      MIDDLE_SESSION_TOKEN: opts.sessionToken,
    };
    for (const key of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const) {
      const value = process.env[key];
      if (typeof value === "string" && value.length > 0) env[key] = value;
    }
    return { argv: ["copilot", "--allow-all-tools"], env: { ...env, ...opts.envOverrides } };
  },
  buildPromptText,
  enterAutoMode,
  resolveTranscriptPath,
  readTranscriptState,
  classifyStop,
  detectRateLimit,
};
