import { existsSync } from "node:fs";
import { join } from "node:path";
import { claudeAdapter } from "@middle/adapter-claude";
import type { AgentAdapter } from "@middle/core";
import { loadConfig } from "@middle/core";
import { dispatchRecommender, resolveRecommenderOptions } from "@middle/dispatcher/src/recommender-run.ts";

export type RunRecommenderOptions = {
  /** Override the global config path (defaults to `~/.middle/config.toml`). */
  configPath?: string;
  /** Injected dispatch seam — defaults to the real runner. Tests override it. */
  dispatch?: typeof dispatchRecommender;
};

/** Phase 7 adapter registry — only `claude` is implemented. */
function getAdapter(name: string): AgentAdapter {
  if (name !== "claude") throw new Error(`unknown adapter: ${name}`);
  return claudeAdapter;
}

/**
 * `mm run-recommender <repo>` — trigger a recommender run for the given repo.
 * Read-only at this phase: the recommender rewrites the repo's state issue but
 * nothing auto-dispatches. Returns a process exit code: 0 when the run
 * completes, 1 otherwise.
 */
export async function runRecommender(
  repoPath: string,
  opts: RunRecommenderOptions = {},
): Promise<number> {
  if (!existsSync(join(repoPath, ".git"))) {
    console.error(`mm run-recommender: "${repoPath}" is not a git repository`);
    return 1;
  }

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig({
      globalPath: opts.configPath,
      repoPath: join(repoPath, ".middle", "config.toml"),
    });
  } catch (error) {
    console.error(`mm run-recommender: failed to load config — ${(error as Error).message}`);
    return 1;
  }

  const resolved = await resolveRecommenderOptions(repoPath, config, getAdapter);
  if (!resolved.ok) {
    console.error(`mm run-recommender: ${resolved.error}`);
    return 1;
  }

  const dispatch = opts.dispatch ?? dispatchRecommender;
  let result: Awaited<ReturnType<typeof dispatchRecommender>>;
  try {
    result = await dispatch(resolved.options);
  } catch (error) {
    console.error(`mm run-recommender: failed — ${(error as Error).message}`);
    return 1;
  }

  console.log(
    `mm run-recommender: ${resolved.options.repoSlug} state issue #${resolved.options.stateIssue} → workflow ${result.workflowId} settled — ${result.state}`,
  );
  return result.state === "completed" ? 0 : 1;
}
