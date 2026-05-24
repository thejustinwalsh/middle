import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { InstallHookOpts, NormalizedEvent } from "@middle/core";
import { HOOK_SH, PR_READY_GATE_SH } from "@middle/core";

/**
 * Map each Claude hook event to the normalized taxonomy. Order is the order the
 * entries appear in `settings.json`. Source of truth: build spec → "Normalized
 * event taxonomy".
 *
 * Two entries are **load-bearing for dispatch**, not merely observational:
 *   - `SessionStart` → `session.started` carries `session_id`/`transcript_path`
 *     and triggers the launch→drive transition.
 *   - `Stop` → `agent.stopped` is the turn boundary the workflow classifies.
 * `SubagentStop` maps to its own `agent.subagent-stopped` event — NOT
 * `agent.stopped`. A subagent (e.g. an Explore agent the implementer spawned)
 * finishing is not the *main* agent's turn boundary; the main agent is still
 * working. Conflating the two let the first subagent's completion resolve
 * `awaitStop`, which classified a `bare-stop` and tore the workflow down
 * mid-research. `agent.subagent-stopped` is recorded but never resolves the
 * stop awaiter.
 */
const CLAUDE_EVENT_MAP: ReadonlyArray<[claudeEvent: string, normalized: NormalizedEvent]> = [
  ["SessionStart", "session.started"],
  ["UserPromptSubmit", "turn.started"],
  ["PreToolUse", "tool.pre"],
  ["PostToolUse", "tool.post"],
  ["Notification", "agent.notification"],
  ["Stop", "agent.stopped"],
  ["SubagentStop", "agent.subagent-stopped"],
  ["SessionEnd", "session.ended"],
];

/**
 * Write the full Claude hook configuration into the worktree: the universal
 * `hook.sh` (single-sourced from `@middle/core`), plus a `.claude/settings.json`
 * registering every event in the taxonomy. Each entry invokes
 * `"<abs>/hook.sh" <normalized-event>` and forwards the hook's stdin payload.
 *
 * The settings reference an **absolute** hook path: Claude fires hooks from
 * whatever directory the agent has `cd`'d into, so a relative
 * `.middle/hooks/hook.sh` would fail to resolve from a subdirectory and silently
 * skip the POST. The path is double-quoted so a worktree under a home dir with
 * spaces (e.g. `/Users/Jane Doe/...`) doesn't mis-parse the hook command.
 *
 * The env vars the script reads (`MIDDLE_DISPATCHER_URL`, `MIDDLE_SESSION`,
 * `MIDDLE_SESSION_TOKEN`, `MIDDLE_EPIC`) are injected by tmux at spawn time.
 */
export async function installHooks(opts: InstallHookOpts): Promise<void> {
  const scriptPath = join(opts.worktree, opts.hookScriptPath);
  await mkdir(dirname(scriptPath), { recursive: true });
  await Bun.write(scriptPath, HOOK_SH);
  await chmod(scriptPath, 0o755);

  // The PR-ready guard's blocking PreToolUse hook lives beside hook.sh.
  const gateScriptPath = join(dirname(scriptPath), "pr-ready-gate.sh");
  await Bun.write(gateScriptPath, PR_READY_GATE_SH);
  await chmod(gateScriptPath, 0o755);

  const claudeDir = join(opts.worktree, ".claude");
  await mkdir(claudeDir, { recursive: true });

  type HookGroup = { matcher?: string; hooks: Array<{ type: "command"; command: string }> };
  const hooks: Record<string, HookGroup[]> = {};
  for (const [claudeEvent, normalized] of CLAUDE_EVENT_MAP) {
    hooks[claudeEvent] = [
      { hooks: [{ type: "command", command: `"${scriptPath}" ${normalized}` }] },
    ];
  }
  // Add the PR-ready gate as a SECOND PreToolUse hook, scoped to the Bash tool
  // (only Bash can run `gh pr ready`). It's blocking — exit 2 vetoes the call —
  // so it must not replace the universal heartbeat entry, only sit alongside it.
  hooks.PreToolUse!.push({
    matcher: "Bash",
    hooks: [{ type: "command", command: `"${gateScriptPath}"` }],
  });

  await Bun.write(join(claudeDir, "settings.json"), `${JSON.stringify({ hooks }, null, 2)}\n`);
}
