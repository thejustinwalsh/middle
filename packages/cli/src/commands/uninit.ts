import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { realDeps, uninitRepo, type BootstrapDeps } from "../bootstrap/index.ts";

export type UninitCliOptions = {
  dryRun?: boolean;
  deps?: BootstrapDeps;
};

/**
 * `mm uninit <path>` — reverse `mm init`. Prints a removal summary, or the plan
 * under `--dry-run`. Returns a process exit code.
 */
export async function runUninit(pathArg: string, opts: UninitCliOptions = {}): Promise<number> {
  const repo = resolve(pathArg);
  const deps = opts.deps ?? realDeps;

  if (!existsSync(join(repo, ".middle"))) {
    console.error(`mm uninit: "${repo}" does not look bootstrapped (no .middle/)`);
    return 1;
  }

  try {
    const result = await uninitRepo(repo, deps, { dryRun: opts.dryRun ?? false });
    if (result.dryRun) {
      console.log(`mm uninit (dry run) — ${repo}\n`);
      for (const action of result.actions) console.log(`  • ${action}`);
      console.log("\nno changes made.");
      return 0;
    }
    console.log("✓ middle removed");
    for (const action of result.actions) console.log(`  • ${action}`);
    if (result.stateIssue > 0) {
      console.log(`\nnote: the \`agent-queue:state\` label was preserved (delete it manually if desired).`);
    }
    return 0;
  } catch (error) {
    console.error(`mm uninit: ${(error as Error).message}`);
    return 1;
  }
}
