import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { InstallHookOpts, NormalizedEvent } from "@middle/core";
import { HOOK_SH, PR_READY_GATE_SH } from "@middle/core";

/**
 * Map each Codex hook event name to the normalized taxonomy. Names come from the
 * build spec's "Normalized event taxonomy" table ("Trigger (Codex)" column):
 * `startup`/`turn-start`/`command`/`turn-end`/`shutdown`, with the `command`
 * event distinguished into pre / success / failure. Codex has no equivalent of
 * Claude's `Notification` or `SubagentStop`, so `agent.notification` /
 * `agent.subagent-stopped` are not emitted.
 *
 * Two entries are load-bearing for dispatch: `startup → session.started`
 * (carries the rollout path, triggers launch→drive) and `turn-end →
 * agent.stopped` (the turn boundary `classifyStop` reacts to).
 */
const CODEX_EVENT_MAP: ReadonlyArray<[codexEvent: string, normalized: NormalizedEvent]> = [
  ["startup", "session.started"],
  ["turn-start", "turn.started"],
  ["command", "tool.pre"],
  ["command-success", "tool.post"],
  ["command-failure", "tool.failed"],
  ["turn-end", "agent.stopped"],
  ["shutdown", "session.ended"],
];

/** Escape a string for a TOML basic (double-quoted) value: backslash + quote. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Write the full Codex hook configuration into the worktree: the universal
 * `hook.sh` and the PR-ready gate script (single-sourced from `@middle/core`,
 * shared verbatim with the Claude adapter), plus a `.codex/config.toml` that
 * sets the auto-mode policy and registers every taxonomy event in a `[hooks]`
 * block.
 *
 * Auto mode lives in config, not the launch command (per spec): `approval_policy
 * = "never"` + `sandbox = "workspace-write"` let the session run unattended.
 *
 * Each hook invokes the script **through `sh`** with an **absolute** path,
 * double-quoted — same rationale as the Claude adapter: `sh` runs the file
 * regardless of its exec bit (so a missing bit can't wedge the blocking
 * command-gate), and the absolute path resolves from whatever subdirectory the
 * agent has `cd`'d into. The PR-ready gate is registered as a second hook on the
 * `command` (pre) event so it sits alongside the heartbeat, mirroring Claude's
 * two PreToolUse hooks; the gate script self-filters to `gh pr ready`.
 *
 * The exact `[hooks]` schema is a live-run tightening point (see
 * `planning/issues/60/decisions.md`); the array-of-tables shape is the baseline.
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
    'sandbox = "workspace-write"',
    "",
  ];
  for (const [codexEvent, normalized] of CODEX_EVENT_MAP) {
    lines.push(`[[hooks.${codexEvent}]]`);
    lines.push(`command = ${tomlString(`sh "${scriptPath}" ${normalized}`)}`);
    lines.push("");
    // The blocking PR-ready gate rides the pre-command event, second so the
    // heartbeat stays first (the gate self-filters to `gh pr ready`).
    if (codexEvent === "command") {
      lines.push(`[[hooks.${codexEvent}]]`);
      lines.push(`command = ${tomlString(`sh "${gateScriptPath}"`)}`);
      lines.push("");
    }
  }

  const codexDir = join(opts.worktree, ".codex");
  await mkdir(codexDir, { recursive: true });
  await Bun.write(join(codexDir, "config.toml"), `${lines.join("\n")}\n`);
}
