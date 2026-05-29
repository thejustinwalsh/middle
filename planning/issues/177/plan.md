# Issue #177: Make the CodexAdapter functionally dispatchable against live codex 0.133.0

**Link:** https://github.com/thejustinwalsh/middle/issues/177
**Branch:** middle-issue-177

## Goal
Turn the Codex adapter's start-generous, never-live-validated baselines into a
functionally dispatchable adapter, verified against the real `codex-cli 0.133.0`
binary: hooks fire end-to-end (heartbeat), the worktree config is actually
loaded, the sandbox policy applies, and stop/rate-limit read the real session
artifact. No `AgentAdapter` interface change — all fixes internal to
`packages/adapters/codex/`.

## What the binary actually does (reverse-engineered + empirically confirmed)
Codex 0.133.0's hooks are **modelled on Claude Code's** (the binary even
references `CLAUDE_PLUGIN_ROOT`). Confirmed by reading the binary's embedded
schema *and* by live tmux runs:

- **Event names** (`HookEventNameWire`, PascalCase): `SessionStart`,
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `PostCompact`,
  `PermissionRequest`, `SubagentStart`, `SubagentStop`, `Stop`. The adapter's
  `startup/turn-start/command/turn-end/shutdown` names are **fiction** — they
  match nothing and fire nothing.
- **Config shape** (`config.toml`): a `[hooks]` table keyed by those event
  names, each an array of *matcher groups* `{ matcher?, hooks: [{ type =
  "command", command = "…" }] }` — i.e. Claude's `settings.json` hooks shape, in
  TOML. The adapter's flat `[[hooks.<event>]] command = …` is the wrong shape.
- **Hook payload** (Claude-identical): `session_id`, `turn_id`,
  `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`,
  `prompt`, `tool_name` (the shell tool is **`Bash`**), `tool_input.command`,
  `tool_response`, `last_assistant_message`, `source` (`startup/resume/clear/compact`).
- **Trust**: interactive codex shows a **"Hooks need review"** dialog at boot;
  hooks fire only after "Trust all and continue". `--dangerously-bypass-hook-trust`
  does **not** suppress it interactively. A first-run **directory-trust** dialog
  also appears unless the cwd is pre-trusted in config (`[projects."<cwd>"]
  trust_level = "trusted"`).
- **`sandbox`** is rejected (`--strict-config`: `unknown configuration field
  'sandbox'`); the real key is **`sandbox_mode`** — confirmed applied
  (`sandbox: workspace-write` in the run banner).
- **Transcript**: a JSONL **rollout** at `$CODEX_HOME/sessions/YYYY/MM/DD/
  rollout-<ts>-<uuid>.jsonl` (the issue's "SQLite-only, no sessions dir" is
  stale for 0.133.0). The `SessionStart` payload's `transcript_path` points at
  it. Rollout has structured **rate-limit** data in `token_count` events
  (`rate_limits.primary.{used_percent, resets_at}`, `rate_limit_reached_type`)
  — a real reset timestamp, not a regex guess.
- **`CODEX_HOME`** repoints **all** codex state (auth, caches, sqlite, sessions)
  at the dir; auth must be made reachable there.

## Approach
- Rewrite `hooks.ts` to emit the real `[hooks]` schema (PascalCase events,
  matcher groups, `type="command"`), `sandbox_mode`, and pre-trust the worktree.
- Set `CODEX_HOME=<worktree>/.codex` in `buildLaunchCommand`; symlink the
  operator's `auth.json` into the worktree home so a repointed home stays
  authenticated.
- Teach `enterAutoMode` to answer the hooks-trust (and directory-trust) dialogs.
- Switch stop/rate-limit detection to the structured `rate_limits` block in the
  rollout (`transcript.ts` already parses the real rollout format correctly).
- Rewrite `adapter.test.ts` against the **real** captured payloads/rollout, and
  add a live end-to-end verification proving the heartbeat through the real
  adapter code.

## Phases (one PR; gaps from the issue are the phases)
1. Hooks schema + trust (the keystone) — real `[hooks]`, event names, matcher
   groups, PR-ready `Bash` gate; `enterAutoMode` answers the trust dialogs.
2. `CODEX_HOME` + auth reachability — `buildLaunchCommand` env; auth symlink.
3. Sandbox key — `sandbox_mode` (under `--strict-config`).
4. Stop + rate-limit against the real artifact — structured `rate_limits`.
5. Live end-to-end verification — heartbeat observed through the real adapter;
   schema-conforming normalized events POSTed.

## Files likely to change
- `packages/adapters/codex/src/hooks.ts` — real schema, events, sandbox_mode, trust, gate.
- `packages/adapters/codex/src/index.ts` — `CODEX_HOME`, auth symlink, dialog-answering `enterAutoMode`.
- `packages/adapters/codex/src/classify.ts` — structured rate-limit from rollout.
- `packages/adapters/codex/src/transcript.ts` — doc updates (logic already matches the real rollout).
- `packages/adapters/codex/test/adapter.test.ts` — rewrite against real schema/payloads.
- A live-verification script + its evidence captured in the PR.

## Out of scope
- Any `AgentAdapter` interface change (the Phase-10 headline holds).
- The Claude adapter (untouched).
- Codex `exec`/app-server mode (middle dispatches interactive `codex`; hooks
  don't engage in `exec`, which is fine — we never use it).

## Open questions
- None blocking. The recipe is confirmed live against codex 0.133.0.
