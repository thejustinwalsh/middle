import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { InstallHookOpts, NormalizedEvent } from "@middle/core";
import { HOOK_SH, PR_READY_GATE_SH } from "@middle/core";

/**
 * Map each real Copilot 1.0.54 hook event to the normalized taxonomy. The event
 * names are camelCase (the Copilot hooks schema's keys) — read off the live
 * `copilot` binary and confirmed firing on an interactive run (the probe in
 * `planning/issues/124/decisions.md`). Copilot's hook surface is its own, NOT
 * Claude-modelled like Codex's: camelCase events, camelCase + string-encoded
 * payloads, and crucially **no per-turn stop event**.
 *
 * Two entries are load-bearing for dispatch:
 *   - `sessionStart → session.started` carries `sessionId` (camelCase) and is the
 *     ready signal that triggers launch→drive. (No `transcript_path` — the adapter
 *     derives it; see `transcript.ts`.)
 *   - `sessionEnd → agent.stopped` is the turn boundary `classifyStop` reacts to.
 *     Copilot fires NO per-turn stop hook; `sessionEnd` (fires on session exit) is
 *     its only session/turn boundary, and the implementation drive's done-path
 *     only runs through `agent.stopped`, so this mapping is required, not merely
 *     chosen. This is the documented seam Copilot strains (vs. Claude/Codex, whose
 *     stop hook fires while the process stays alive). See
 *     `planning/issues/124/decisions.md`.
 *
 * `errorOccurred` is intentionally NOT mapped: its `errorContext`
 * (`model_call`/`tool_execution`/`system`/`user_input`) is broader than `tool.failed`
 * and mapping it would mis-signal a model-call error as a tool failure. The
 * dispatcher hard-depends only on `session.started` + `agent.stopped`, both mapped.
 * Copilot has no `Notification`/`SubagentStop` analog, so those normalized events
 * are simply not emitted by this adapter (the vocabulary tolerates that).
 */
const COPILOT_EVENT_MAP: ReadonlyArray<[copilotEvent: string, normalized: NormalizedEvent]> = [
  ["sessionStart", "session.started"],
  ["userPromptSubmitted", "turn.started"],
  ["preToolUse", "tool.pre"],
  ["postToolUse", "tool.post"],
  ["sessionEnd", "agent.stopped"],
];

/** Copilot's shell tool name (confirmed `bash` via the live probe) — the matcher the PR-ready gate scopes to. */
export const COPILOT_SHELL_TOOL = "bash";

type CommandHook = {
  type: "command";
  command: string;
  matcher?: string;
  timeoutSec: number;
};

/**
 * Write the full Copilot hook configuration into the worktree: the universal
 * `hook.sh` and the PR-ready gate script (single-sourced from `@middle/core`,
 * byte-identical with the Claude/Codex adapters), plus the worktree-local Copilot
 * home (`<worktree>/.copilot`, pointed at by `buildLaunchCommand`'s `COPILOT_HOME`):
 *
 *   - `hooks/middle.json` — the personal hooks file (`{version:1, hooks:{…}}`,
 *     the documented `~/.copilot/hooks/*.json` schema), registering every
 *     normalized event as a `command`-type hook invoked through `sh` with an
 *     **absolute**, double-quoted path. `sh` runs the file regardless of its exec
 *     bit (so a missing bit can't wedge the blocking gate) and the absolute path
 *     resolves from whatever subdirectory the agent `cd`'d into — same rationale
 *     as the Claude/Codex adapters.
 *   - `config.json` — pre-trusts the worktree via `trustedFolders` so Copilot
 *     skips the first-run folder-trust dialog (the remaining belt-and-suspenders
 *     auto-mode comes from the `--allow-all-tools` launch flag), and silences the
 *     animated banner.
 *
 * The PR-ready gate rides a SECOND `preToolUse` hook scoped (via `matcher`) to the
 * shell tool — `bash` for Copilot (lowercase; confirmed by the probe), distinct
 * from Claude/Codex's `Bash`. Copilot's `preToolUse` is **fail-closed** (a non-zero
 * exit denies the tool), which is exactly the gate's contract (`exit 2` blocks
 * `gh pr ready`); the universal heartbeat sits in the first, matcher-less group and
 * always exits 0 so it never denies a tool.
 *
 * Unlike Codex, NO auth symlink is written: Copilot authenticates via `gh`
 * (`~/.config/gh`), which `COPILOT_HOME` does not repoint — so the worktree home
 * needs no credential file.
 */
export async function installHooks(opts: InstallHookOpts): Promise<void> {
  const scriptPath = join(opts.worktree, opts.hookScriptPath);
  await mkdir(dirname(scriptPath), { recursive: true });
  await Bun.write(scriptPath, HOOK_SH);
  await chmod(scriptPath, 0o755);

  const gateScriptPath = join(dirname(scriptPath), "pr-ready-gate.sh");
  await Bun.write(gateScriptPath, PR_READY_GATE_SH);
  await chmod(gateScriptPath, 0o755);

  const hooks: Record<string, CommandHook[]> = {};
  for (const [copilotEvent, normalized] of COPILOT_EVENT_MAP) {
    hooks[copilotEvent] = [
      { type: "command", command: `sh "${scriptPath}" ${normalized}`, timeoutSec: 10 },
    ];
    // The blocking PR-ready gate rides a second preToolUse matcher group scoped to
    // the shell tool (the gate self-filters to `gh pr ready`); it sits alongside
    // the universal heartbeat rather than replacing it.
    if (copilotEvent === "preToolUse") {
      hooks[copilotEvent]!.push({
        type: "command",
        command: `sh "${gateScriptPath}"`,
        matcher: COPILOT_SHELL_TOOL,
        timeoutSec: 20,
      });
    }
  }

  const copilotDir = join(opts.worktree, ".copilot");
  await mkdir(join(copilotDir, "hooks"), { recursive: true });
  await Bun.write(
    join(copilotDir, "hooks", "middle.json"),
    `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`,
  );
  await Bun.write(
    join(copilotDir, "config.json"),
    `${JSON.stringify({ trustedFolders: [opts.worktree], banner: "never" }, null, 2)}\n`,
  );
}
