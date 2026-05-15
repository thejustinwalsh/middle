import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { claudeAdapter } from "@middle/adapter-claude";
import type { AgentAdapter } from "@middle/core";
import { loadConfig } from "@middle/core";
import { dispatchEpic } from "@middle/dispatcher/src/dispatch.ts";

export type DispatchOptions = {
  /** Override the global config path (defaults to `~/.middle/config.toml`). */
  configPath?: string;
};

/** Derive an `owner/name` slug from the repo's `origin` remote, falling back to its directory name. */
async function deriveRepoSlug(repoPath: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repoPath, "remote", "get-url", "origin"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const url = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) === 0 && url) {
    const match = /[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
    if (match) return match[1]!;
  }
  return basename(repoPath);
}

/** Phase 1 adapter registry — only `claude` is implemented. */
function getAdapter(name: string): AgentAdapter {
  if (name !== "claude") throw new Error(`unknown adapter: ${name}`);
  return claudeAdapter;
}

/**
 * `mm dispatch <repo> <epic>` — force-dispatch an Epic (or standalone issue)
 * through the Phase 1 `implementation` workflow: spawn the agent in tmux, drive
 * it, observe the `Stop`, finalize, and clean up the worktree. Returns a process
 * exit code: 0 when the workflow completes, 1 otherwise.
 */
export async function runDispatch(
  repoPath: string,
  epicArg: string,
  opts: DispatchOptions = {},
): Promise<number> {
  const epicNumber = Number(epicArg);
  if (!Number.isInteger(epicNumber) || epicNumber < 1) {
    console.error(`mm dispatch: invalid epic number "${epicArg}"`);
    return 1;
  }
  if (!existsSync(join(repoPath, ".git"))) {
    console.error(`mm dispatch: "${repoPath}" is not a git repository`);
    return 1;
  }

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig({ globalPath: opts.configPath });
  } catch (error) {
    console.error(`mm dispatch: failed to load config — ${(error as Error).message}`);
    return 1;
  }

  const adapterName = config.global.defaultAdapter;
  if (adapterName !== "claude") {
    console.error(
      `mm dispatch: only the 'claude' adapter is available in Phase 1 (config asks for "${adapterName}")`,
    );
    return 1;
  }

  const repoSlug = await deriveRepoSlug(repoPath);
  const result = await dispatchEpic({
    repoPath,
    repoSlug,
    epicNumber,
    adapterName,
    getAdapter,
    dbPath: config.global.dbPath,
    worktreeRoot: config.global.worktreeRoot,
    dispatcherPort: config.global.dispatcherPort,
  });

  console.log(
    `mm dispatch: ${repoSlug} epic #${epicNumber} → workflow ${result.workflowId} settled — ${result.state}`,
  );
  return result.state === "completed" ? 0 : 1;
}
