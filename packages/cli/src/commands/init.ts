import { resolve } from "node:path";
import { initRepo, realDeps, type BootstrapDeps } from "../bootstrap/index.ts";

export type InitCliOptions = {
  dryRun?: boolean;
  /** Injectable for tests; defaults to the gh/git-backed deps. */
  deps?: BootstrapDeps;
  /**
   * Record the repo in the daemon's managed-repo registry (#135) so the
   * recommender cron picks it up cold — wired by the CLI entry to a db write;
   * injectable for tests. Omitted → no registration (e.g. unit tests).
   */
  registerRepo?: (repo: string, repoPath: string) => void;
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
    console.log(
      `✓ middle initialized for ${slug}${result.mode === "fresh" ? "" : ` [${result.mode}]`}`,
    );
    console.log("  skills installed at .claude/skills/, .codex/skills/");
    console.log("  hook script at .middle/hooks/hook.sh");
    console.log(`  ${issueLine}`);
    console.log("  config: .middle/config.toml");
    console.log(`  auto-dispatch: OFF (enable with \`mm config ${slug} auto_dispatch true\`)`);

    // Register the repo so a running/next daemon's recommender cron can find it
    // without a manual dispatch (#135). Best-effort — a registry write failure
    // must not fail an otherwise-successful init.
    try {
      opts.registerRepo?.(slug, repo);
    } catch (error) {
      console.error(`  (note: managed-repo registry write skipped — ${(error as Error).message})`);
    }
    return 0;
  } catch (error) {
    console.error(`mm init: ${(error as Error).message}`);
    return 1;
  }
}
