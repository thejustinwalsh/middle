import { existsSync } from "node:fs";
import { join } from "node:path";
import { claudeAdapter } from "@middle/adapter-claude";
import type { AgentAdapter } from "@middle/core";
import { loadConfig } from "@middle/core";
import {
  dispatchDocumentation,
  resolveDocumentationOptions,
} from "@middle/dispatcher/src/documentation-run.ts";

export type RunDocsOptions = {
  /** Override the global config path (defaults to `~/.middle/config.toml`). */
  configPath?: string;
  /** Injected dispatch seam — defaults to the real runner. Tests override it. */
  dispatch?: typeof dispatchDocumentation;
};

/** Phase 7 adapter registry — only `claude` is implemented. */
function getAdapter(name: string): AgentAdapter {
  if (name !== "claude") throw new Error(`unknown adapter: ${name}`);
  return claudeAdapter;
}

/**
 * `mm docs <repo>` — trigger a documentation run for the given repo. Resolves
 * the repo's docs target (Starlight / Docusaurus / MkDocs / TypeDoc, or the
 * markdown fallback), then runs the docs harvester. With `[docs] write` off
 * (default) the run audits the surface and persists nothing; with it on, the
 * agent discovers-or-authors and the run commits the result and opens a draft
 * PR. Returns a process exit code: 0 when the run completes, 1 otherwise.
 */
export async function runDocs(repoPath: string, opts: RunDocsOptions = {}): Promise<number> {
  if (!existsSync(join(repoPath, ".git"))) {
    console.error(`mm docs: "${repoPath}" is not a git repository`);
    return 1;
  }

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig({
      globalPath: opts.configPath,
      repoPath: join(repoPath, ".middle", "config.toml"),
    });
  } catch (error) {
    console.error(`mm docs: failed to load config — ${(error as Error).message}`);
    return 1;
  }

  const resolved = await resolveDocumentationOptions(repoPath, config, getAdapter);
  if (!resolved.ok) {
    console.error(`mm docs: ${resolved.error}`);
    return 1;
  }

  const dispatch = opts.dispatch ?? dispatchDocumentation;
  let result: Awaited<ReturnType<typeof dispatchDocumentation>>;
  try {
    result = await dispatch(resolved.options);
  } catch (error) {
    console.error(`mm docs: failed — ${(error as Error).message}`);
    return 1;
  }

  console.log(
    `mm docs: ${resolved.options.repoSlug} docs target '${resolved.options.target.name}' (${resolved.options.target.docsRoot}) → workflow ${result.workflowId} settled — ${result.state}`,
  );
  return result.state === "completed" ? 0 : 1;
}
