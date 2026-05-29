import { existsSync } from "node:fs";
import { chmod, mkdir, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { InstallHookOpts, NormalizedEvent } from "@middle/core";
import { HOOK_SH, PR_READY_GATE_SH } from "@middle/core";

/**
 * Make the operator's codex auth reachable under the worktree-local
 * `CODEX_HOME`. Because `buildLaunchCommand` sets `CODEX_HOME=<worktree>/.codex`,
 * codex reads auth from `<worktree>/.codex/auth.json` — not the operator's
 * global `~/.codex/auth.json`. We **symlink** (not copy) the operator's
 * `auth.json` into the worktree home so it stays live across codex's token
 * refresh. The source is the operator's real codex home (`$CODEX_HOME` if the
 * operator set one, else `~/.codex`); if it has no `auth.json` (codex not signed
 * in here), we skip silently — `enterAutoMode` surfaces the needs-login state on
 * the pane instead.
 */
async function linkAuth(codexDir: string): Promise<void> {
  const operatorHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const src = join(operatorHome, "auth.json");
  const dest = join(codexDir, "auth.json");
  if (!existsSync(src) || src === dest) return;
  try {
    await rm(dest, { force: true });
    await symlink(src, dest);
  } catch (err) {
    console.error(`[codex] linkAuth: could not link auth.json — ${(err as Error).message}`);
  }
}

/**
 * Map each real Codex 0.133.0 hook event to the normalized taxonomy. The event
 * names are the binary's `HookEventNameWire` enum (PascalCase) — read off the
 * `codex` binary and confirmed firing on a live interactive run. Codex's hooks
 * are modelled on Claude Code's: same event names, same payload fields, same
 * `Bash` shell-tool name. (The previous `startup/turn-start/command/turn-end/
 * shutdown` taxonomy was a start-generous guess that matched nothing and fired
 * zero hooks.)
 *
 * Two entries are load-bearing for dispatch:
 *   - `SessionStart → session.started` carries `session_id`/`transcript_path`
 *     and triggers the launch→drive transition.
 *   - `Stop → agent.stopped` is the turn boundary `classifyStop` reacts to.
 *
 * `SubagentStop → agent.subagent-stopped` is its own event, never `agent.stopped`
 * — a subagent finishing is not the main agent's turn boundary.
 *
 * Codex has no `Notification` or `SessionEnd` event and no per-tool failure hook
 * (the `PostToolUse` payload carries the tool result), so `agent.notification`,
 * `session.ended`, and `tool.failed` are simply not emitted by this adapter. The
 * normalized vocabulary tolerates that — the dispatcher hard-depends only on
 * `session.started` and `agent.stopped`, both mapped here.
 */
const CODEX_EVENT_MAP: ReadonlyArray<[codexEvent: string, normalized: NormalizedEvent]> = [
  ["SessionStart", "session.started"],
  ["UserPromptSubmit", "turn.started"],
  ["PreToolUse", "tool.pre"],
  ["PostToolUse", "tool.post"],
  ["Stop", "agent.stopped"],
  ["SubagentStop", "agent.subagent-stopped"],
];

/** Escape a string for a TOML basic (double-quoted) value: backslash + quote. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * One Codex hook matcher group, rendered as a TOML array-of-tables entry under
 * `[[hooks.<Event>]]`. Mirrors Claude's `settings.json` hook shape in TOML: an
 * optional `matcher` (scopes the group to a tool name) followed by a nested
 * `[[hooks.<Event>.hooks]]` command handler. The `matcher` key MUST be emitted
 * before the nested `hooks` table — once `[[hooks.<Event>.hooks]]` opens, bare
 * keys bind to the nested table, not the group.
 */
function renderMatcherGroup(event: string, command: string, matcher?: string): string[] {
  const lines = [`[[hooks.${event}]]`];
  if (matcher !== undefined) lines.push(`matcher = ${tomlString(matcher)}`);
  lines.push(
    `[[hooks.${event}.hooks]]`,
    'type = "command"',
    `command = ${tomlString(command)}`,
    "",
  );
  return lines;
}

/**
 * Write the full Codex hook configuration into the worktree: the universal
 * `hook.sh` and the PR-ready gate script (single-sourced from `@middle/core`,
 * shared verbatim with the Claude adapter), plus a `.codex/config.toml` that
 * sets the auto-mode policy, pre-trusts the worktree, and registers every
 * normalized event in a real `[hooks]` block.
 *
 * Config decisions, all confirmed against codex 0.133.0:
 *   - **`sandbox_mode`**, not `sandbox`: `--strict-config` rejects bare `sandbox`
 *     (`unknown configuration field 'sandbox'`); without strict-config it is
 *     silently ignored, so the intended policy never applies.
 *   - **`[projects."<worktree>"] trust_level = "trusted"`**: pre-trusts the cwd
 *     so codex skips the first-run directory-trust dialog and loads project-local
 *     config/hooks immediately. (The remaining hooks-trust dialog is answered by
 *     `enterAutoMode`.)
 *   - **`[hooks]`** as matcher groups keyed by the PascalCase event names.
 *
 * Each hook invokes the script **through `sh`** with an **absolute**,
 * double-quoted path — same rationale as the Claude adapter: `sh` runs the file
 * regardless of its exec bit (so a missing bit can't wedge the blocking
 * command-gate), and the absolute path resolves from whatever subdirectory the
 * agent has `cd`'d into. The PR-ready gate is registered as a second `PreToolUse`
 * matcher group scoped to the `Bash` tool (Codex's shell tool, confirmed), so it
 * sits alongside the heartbeat rather than replacing it; the gate script
 * self-filters to `gh pr ready`.
 *
 * `CODEX_HOME` (set by `buildLaunchCommand`) repoints all codex state at
 * `<worktree>/.codex`, so auth must be reachable there too — see the auth
 * symlink in the adapter (`index.ts`).
 */
export async function installHooks(opts: InstallHookOpts): Promise<void> {
  const scriptPath = join(opts.worktree, opts.hookScriptPath);
  await mkdir(dirname(scriptPath), { recursive: true });
  await Bun.write(scriptPath, HOOK_SH);
  await chmod(scriptPath, 0o755);

  const gateScriptPath = join(dirname(scriptPath), "pr-ready-gate.sh");
  await Bun.write(gateScriptPath, PR_READY_GATE_SH);
  await chmod(gateScriptPath, 0o755);

  const lines: string[] = [
    "# middle-managed Codex configuration for headless dispatch.",
    "# Auto mode: no approval prompts, workspace-write sandbox.",
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
    "",
    "# Pre-trust the worktree so codex skips the first-run directory-trust dialog",
    "# and loads this project-local config + hooks immediately.",
    `[projects.${tomlString(opts.worktree)}]`,
    'trust_level = "trusted"',
    "",
  ];
  for (const [codexEvent, normalized] of CODEX_EVENT_MAP) {
    lines.push(...renderMatcherGroup(codexEvent, `sh "${scriptPath}" ${normalized}`));
    // The blocking PR-ready gate rides a second PreToolUse matcher group scoped
    // to the Bash tool, after the universal heartbeat (the gate self-filters to
    // `gh pr ready`).
    if (codexEvent === "PreToolUse") {
      lines.push(...renderMatcherGroup(codexEvent, `sh "${gateScriptPath}"`, "Bash"));
    }
  }

  const codexDir = join(opts.worktree, ".codex");
  await mkdir(codexDir, { recursive: true });
  await Bun.write(join(codexDir, "config.toml"), `${lines.join("\n")}\n`);
  await linkAuth(codexDir);
}
