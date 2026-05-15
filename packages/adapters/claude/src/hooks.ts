import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { InstallHookOpts } from "@middle/core";

/**
 * Phase 1 stub: write a `SessionStart`-only `.claude/settings.json` into the
 * worktree. SessionStart is the one load-bearing hook for this phase — it
 * carries `session_id` and `transcript_path`, which is how the dispatcher
 * discovers the transcript. Phase 2 expands this to the full event taxonomy
 * with HMAC auth and merges into any pre-existing settings file.
 */
export async function installHooks(opts: InstallHookOpts): Promise<void> {
  const claudeDir = join(opts.worktree, ".claude");
  await mkdir(claudeDir, { recursive: true });

  const settings = {
    hooks: {
      SessionStart: [
        {
          hooks: [{ type: "command", command: `${opts.hookScriptPath} session.started` }],
        },
      ],
    },
  };

  await Bun.write(join(claudeDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}
