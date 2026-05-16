import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { InstallHookOpts } from "@middle/core";

/**
 * The universal hook script — POSTs the hook payload to the dispatcher. Args:
 * `$1` is the normalized event name. Never blocks the agent (3s timeout,
 * failure → exit 0). Source of truth: build spec → "Normalized event taxonomy".
 */
const HOOK_SCRIPT = `#!/bin/sh
# .middle/hooks/hook.sh — POSTs hook payloads to the middle dispatcher.
# Args: $1 = normalized event name. Never blocks the agent; failure is a no-op.
EVENT="$1"
exec curl -sS -X POST "\${MIDDLE_DISPATCHER_URL}/hooks/\${EVENT}" \\
  -H "X-Middle-Session: \${MIDDLE_SESSION}" \\
  -H "X-Middle-Token: \${MIDDLE_SESSION_TOKEN}" \\
  -H "X-Middle-Epic: \${MIDDLE_EPIC}" \\
  -H "Content-Type: application/json" \\
  --data-binary @- --max-time 3 || exit 0
`;

/**
 * Phase 1 install: write the universal hook script into the worktree and a
 * minimal `.claude/settings.json` registering the two load-bearing events the
 * `implementation` workflow depends on:
 *
 * - `SessionStart` → `session.started` — discovers `session_id` + `transcript_path`
 * - `Stop` → `agent.stopped` — the turn boundary `classifyStop` reacts to
 *
 * Phase 2 expands to the full event taxonomy, HMAC auth, and merging into any
 * pre-existing settings file.
 */
export async function installHooks(opts: InstallHookOpts): Promise<void> {
  const scriptPath = join(opts.worktree, opts.hookScriptPath);
  await mkdir(dirname(scriptPath), { recursive: true });
  await Bun.write(scriptPath, HOOK_SCRIPT);
  await chmod(scriptPath, 0o755);

  const claudeDir = join(opts.worktree, ".claude");
  await mkdir(claudeDir, { recursive: true });

  const settings = {
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: `${opts.hookScriptPath} session.started` }] },
      ],
      Stop: [
        { hooks: [{ type: "command", command: `${opts.hookScriptPath} agent.stopped` }] },
      ],
    },
  };

  await Bun.write(join(claudeDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}
