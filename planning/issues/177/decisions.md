# Decisions — Issue #177 (Codex adapter, live 0.133.0)

## Codex hooks are Claude-Code-shaped — read off the binary + confirmed live
**File(s):** `packages/adapters/codex/src/hooks.ts`
**Date:** 2026-05-29

**Decision:** Emit a `[hooks]` table keyed by the **real** PascalCase event
names (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`,
`SubagentStop`), each an array of matcher groups
`{ matcher?, hooks = [{ type = "command", command = "…" }] }`. Drop the invented
`startup/turn-start/command/turn-end/shutdown` taxonomy entirely.

**Why:** The adapter's previous names/shape were "start-generous baselines
pending live observation" and fired **zero** hooks. The 0.133.0 binary's
embedded JSON schema defines `HookEventNameWire` as exactly the PascalCase set
above, the config structs are `HookEventsToml` → `MatcherGroup{matcher, hooks}` →
`HookHandlerConfig::Command{command, …}`, and the payload field set
(`session_id/turn_id/transcript_path/cwd/hook_event_name/tool_name/tool_input/
last_assistant_message/source`) is byte-for-byte Claude Code's. A live tmux run
with this shape fired `SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PostToolUse`/
`Stop` end-to-end; the prior shape fired nothing.

**Evidence:** `strings` on the native binary (`HookEventNameWire` enum,
`HookEventsToml`/`MatcherGroup`/`HookHandlerConfig::Command`); live hook log
captured under a temp `CODEX_HOME` (SessionStart carried `transcript_path`, Stop
carried `last_assistant_message`, PreToolUse carried `tool_name:"Bash"` +
`tool_input.command`).

## Normalized-event mapping omits events Codex lacks
**File(s):** `packages/adapters/codex/src/hooks.ts`
**Date:** 2026-05-29

**Decision:** Map `SessionStart→session.started`, `UserPromptSubmit→turn.started`,
`PreToolUse→tool.pre`, `PostToolUse→tool.post`, `Stop→agent.stopped`,
`SubagentStop→agent.subagent-stopped`. Do **not** emit `tool.failed`,
`agent.notification`, or `session.ended` — Codex has no `Notification`/`SessionEnd`
event and no per-tool failure hook (the `PostToolUse` payload carries the result).

**Why:** Inventing config entries for events the binary doesn't define re-creates
the original failure mode (silent no-ops). The normalized vocabulary tolerates an
adapter not emitting every event — the dispatcher only hard-depends on
`session.started` and `agent.stopped`, both mapped.

**Evidence:** `HookEventNameWire` enum has no `Notification`/`SessionEnd`; Claude
maps those, Codex can't.

## `enterAutoMode` answers the trust dialogs (bypass flag is not enough)
**File(s):** `packages/adapters/codex/src/index.ts`
**Date:** 2026-05-29

**Decision:** `enterAutoMode` polls the pane and answers, each at most once: the
**hooks-trust** dialog ("Hooks need review" → select "Trust all and continue")
and, as defense-in-depth, the first-run **directory-trust** dialog ("Do you trust
the contents of this directory?" → "Yes, continue"). Keep the needs-login
fast-fail. Mirrors the Claude adapter's boot-dialog driver.

**Why:** Live tmux runs showed `--dangerously-bypass-hook-trust` does **not**
suppress the interactive hooks-trust dialog; without answering it, "hooks won't
run". The directory dialog is pre-empted by config trust (below) but answered too
in case a future config path misses it.

**Evidence:** Live pane captures of both dialogs; hooks fired only after "Trust
all and continue".

## Pre-trust the worktree in config to skip the directory dialog
**File(s):** `packages/adapters/codex/src/hooks.ts`
**Date:** 2026-05-29

**Decision:** Write `[projects."<worktree>"] trust_level = "trusted"` into the
worktree `config.toml`.

**Why:** With the cwd pre-trusted, codex skips the directory-trust dialog and
loads project-local config/hooks immediately, leaving only the hooks-trust dialog
for `enterAutoMode`. Confirmed: pre-trusting reduced two dialogs to one.

## `CODEX_HOME` repoint + auth symlink
**File(s):** `packages/adapters/codex/src/index.ts`, `hooks.ts`
**Date:** 2026-05-29

**Decision:** `buildLaunchCommand` sets `CODEX_HOME=<worktree>/.codex`.
`installHooks` symlinks `<operatorHome>/auth.json` → `<worktree>/.codex/auth.json`
(operator home = `$CODEX_HOME` or `~/.codex`), skipping silently if absent.

**Why:** Without `CODEX_HOME`, codex reads the operator's global config and never
sees the worktree's auto-mode + hooks. Setting it repoints **all** state at the
worktree, so auth must be reachable there; a **symlink** (not a copy) stays live
across token refresh. Confirmed: a temp home with a copied/symlinked `auth.json`
ran authenticated end-to-end.

**Evidence:** `codex doctor` reads auth from `$CODEX_HOME/auth.json`; the live
runs used a temp `CODEX_HOME` with `auth.json` present and stayed signed in.

## `sandbox_mode`, not `sandbox`
**File(s):** `packages/adapters/codex/src/hooks.ts`
**Date:** 2026-05-29

**Decision:** Emit `sandbox_mode = "workspace-write"`.

**Why:** `--strict-config` rejects bare `sandbox` (`unknown configuration field
'sandbox'`); without strict-config it's silently ignored, so the policy never
applies. `sandbox_mode` is accepted and applied.

**Evidence:** `codex --strict-config exec` errored on `sandbox`; a run with
`sandbox_mode = "workspace-write"` printed `sandbox: workspace-write` in the banner.

## Rate-limit from the structured `rate_limits` block, not a tail regex
**File(s):** `packages/adapters/codex/src/classify.ts`
**Date:** 2026-05-29

**Decision:** Read the rollout's most recent `token_count` event's `rate_limits`:
treat it as rate-limited when `rate_limit_reached_type` is non-null (or a
`primary.used_percent >= 100`), with `resetAt` = ISO(`primary.resets_at` epoch).
Keep a textual fallback for message-based signals.

**Why:** The rollout carries a real, structured reset timestamp; a regex on the
tail both misses it and risks false positives. This reads the **real session
artifact** the acceptance criterion names, and yields a precise `resetAt` instead
of "unknown".

**Evidence:** Captured `token_count` payload:
`rate_limits.primary.{used_percent:3.0, resets_at:1780634498}`,
`rate_limit_reached_type:null` on a healthy run.

## DISCOVERY (blocker): codex's interactive SessionStart is prompt-triggered, not boot-triggered
**File(s):** dispatcher launch→drive flow (`packages/dispatcher/src/workflows/implementation.ts`), `AgentAdapter` interface
**Date:** 2026-05-29

**Finding:** Live validation shows interactive `codex` does NOT create a session
(no rollout file, no `SessionStart` hook) until the **first user prompt is
submitted**. Confirmed: after answering the hooks-trust dialog and waiting 25s
idle, zero hooks fired and zero rollout files existed; the instant a prompt was
submitted, `SessionStart` (source `startup`) fired, then `turn.started`/`Stop`.
There is no codex config/flag to start a session eagerly at boot (the `[PROMPT]`
CLI arg is literally "the user prompt to start the session").

**Why it's a blocker:** The dispatcher drives every adapter as
`enterAutoMode` (parallel) → `awaitSessionStart(timeout)` → `sendText(prompt)`.
Claude fires `SessionStart` at boot (after its dialogs), so it works. Codex never
fires `SessionStart` until a prompt arrives — so `awaitSessionStart` blocks until
timeout and a real dispatch **fails**. This is the launch→drive ORDER, not the
adapter's internals.

**Why I paused instead of fixing it unilaterally:** The issue's stated premise is
"No signature change is required … all fixes are internal to
`packages/adapters/codex/`." That premise holds for gaps 1–4 (all fixed with zero
interface change). It does NOT hold for full live dispatch (acceptance criterion
5): the only clean fix touches shared code — an additive optional
`AgentAdapter` capability (e.g. `startsSessionOnFirstPrompt`) plus a dispatcher
branch that, for such adapters, sends the prompt *first* (the hook server already
stashes the resulting `SessionStart`, so ordering is race-safe) and has codex's
`enterAutoMode` resolve once trust is answered. That contradicts the Phase-10
"no interface change" headline, so it's a scope/design decision for the human,
not something to re-architect unilaterally in a codex-adapter-scoped issue.

**Candidate space (one clearly-leading approach):**
1. Additive optional `AgentAdapter.startsSessionOnFirstPrompt?: boolean` + a
   dispatcher launch-ordering branch (prompt-first for codex). Zero Claude-path
   change. ← recommended.
2. Generic "probe-then-prompt" fallback in the dispatcher (no interface change)
   — risks a Claude regression if Claude boots slower than the probe window
   (prompt sent before Claude is ready → lost).
3. Pass the prompt as a `codex` CLI arg via `buildLaunchCommand` — needs the
   prompt in `LaunchOpts` (a real interface change) and causes a double-send.
4. Codex eager-session config — investigated, does not exist.

## Discard curl's response body in the shared `hook.sh` (codex parses hook stdout)
**File(s):** `packages/core/src/hook-script.ts`, `packages/cli/src/bootstrap-assets/hooks/hook.sh`
**Date:** 2026-05-29

**Decision:** Add `-o /dev/null` to the `curl` in the universal `HOOK_SH` (and
its byte-identical bootstrap mirror), discarding the dispatcher's response body.

**Why:** A live codex run logged `Stop hook (failed) — hook returned invalid
stop hook JSON output` on every hook. Codex (unlike Claude) parses each hook's
**stdout** as the hook's structured JSON output; the dispatcher's plain `ok`
body, echoed to stdout by curl, isn't valid hook JSON. The events still POSTed
(middle got the heartbeat), but the per-fire error is noisy and risks a future
codex version treating invalid hook JSON as a hard block. Discarding the body
leaves clean empty stdout — a no-op for both codex and Claude. This is a shared
`@middle/core` change, but it's load-bearing for clean codex dispatch and
strictly improves the Claude path too; the drift test keeps the mirror in lockstep.

**Evidence:** Live tmux run showed the "Stop hook (failed)" error with the body
echoed; the same run with `-o /dev/null` showed no hook error and the command
ran clean. The end-to-end verify script (`scripts/verify-live-hooks.ts`) then
passed all five heartbeat events with no codex-side hook errors.

## `transcript.ts` already matches the real rollout — keep it
**File(s):** `packages/adapters/codex/src/transcript.ts`
**Date:** 2026-05-29

**Decision:** Leave `readTranscriptState`/`resolveTranscriptPath` logic as-is
(doc-only touch-ups). `transcript_path` priority resolution, assistant-message
turn counting, `function_call` tool-name capture, and
`info.total_token_usage.{input_tokens,cached_input_tokens}` context fill all
match the real rollout schema.

**Evidence:** A captured rollout: assistant turns are `response_item`
`payload.type:"message" role:"assistant"`; tool calls are `function_call`
with `name:"exec_command"`; context usage lives in `event_msg` `token_count`
`info.total_token_usage` — exactly what the parser reads.
