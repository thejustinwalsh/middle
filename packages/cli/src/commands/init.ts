import { resolve } from "node:path";
import { initRepo, realDeps, type BootstrapDeps } from "../bootstrap/index.ts";

export type InitCliOptions = {
  dryRun?: boolean;
  /** Injectable for tests; defaults to the gh/git-backed deps. */
  deps?: BootstrapDeps;
};

/**
 * `mm init <path>` — bootstrap middle into a target repo. Prints the spec's
 * summary on success, or the planned actions under `--dry-run`. Returns a
 * process exit code (0 ok, 1 on a validation/bootstrap failure).
 */
export async function runInit(pathArg: string, opts: InitCliOptions = {}): Promise<number> {
  const repo = resolve(pathArg);
  const deps = opts.deps ?? realDeps;
  try {
    const result = await initRepo(repo, deps, { dryRun: opts.dryRun ?? false });
    const slug = `${result.info.owner}/${result.info.name}`;

    if (result.dryRun) {
      console.log(`mm init (dry run) — ${slug} [${result.mode}]\n`);
      for (const action of result.actions) console.log(`  • ${action}`);
      console.log("\nno changes made.");
      return 0;
    }

    const issueLine =
      result.mode === "fresh"
        ? `state issue created: #${result.stateIssue}`
        : `state issue: #${result.stateIssue} (kept)`;
    console.log(`✓ middle initialized for ${slug}${result.mode === "fresh" ? "" : ` [${result.mode}]`}`);
    console.log("  skills installed at .claude/skills/, .codex/skills/");
    console.log("  hook script at .middle/hooks/hook.sh");
    console.log(`  ${issueLine}`);
    console.log("  config: .middle/config.toml");
    console.log(`  auto-dispatch: OFF (enable with \`mm config ${slug} auto_dispatch true\`)`);
    return 0;
  } catch (error) {
    console.error(`mm init: ${(error as Error).message}`);
    return 1;
  }
}
