#!/usr/bin/env bun
/**
 * @packageDocumentation
 * @module @middle/cli
 *
 * The `mm` binary — commander wiring over the command functions in `commands/`.
 * Each subcommand delegates to a `run*` function and exits with its return code.
 *
 * Public surface:
 * - the `mm` CLI: `init`, `uninit`, `start`, `stop`, `status`, `doctor`,
 *   `dispatch`, `pause`, `resume`, `config`, `run-recommender`, `docs`,
 *   `audit-issues`, `version`
 *
 * Where things live:
 * - `commands/` — one `run*` function per subcommand
 * - `bootstrap/` — `mm init`/`uninit` internals (skill/hook/config stamping)
 * - `bootstrap-assets/` — the files `mm init` stamps into a target repo
 * - `checks/` — repo-convention checks surfaced by `mm doctor`
 * - `paths.ts` — shared path resolution
 *
 * Gotchas:
 * - This file is the `mm` bin (shebang + mode 100755); keep it executable.
 *
 * claude-md: false
 */
import { Command } from "commander";
import { runAuditIssues } from "./commands/audit-issues.ts";
import { runConfig } from "./commands/config.ts";
import { runDispatch } from "./commands/dispatch.ts";
import { runDocs } from "./commands/docs.ts";
import { runDoctor } from "./commands/doctor.ts";
import { loadConfig } from "@middle/core";
import { openAndMigrate } from "@middle/dispatcher/src/db.ts";
import { registerManagedRepo } from "@middle/dispatcher/src/repo-config.ts";
import { runInit } from "./commands/init.ts";

/**
 * Record an initialized repo in the daemon's managed-repo registry (#135) so the
 * recommender cron picks it up without a manual dispatch. Opens the daemon db at
 * the configured `db_path`, upserts the checkout path, and closes. Best-effort:
 * a throw here is caught by `runInit` and never fails the init.
 */
function registerRepoInDaemonDb(repo: string, repoPath: string): void {
  const config = loadConfig({ globalPath: process.env.MIDDLE_CONFIG });
  const db = openAndMigrate(config.global.dbPath);
  try {
    registerManagedRepo(db, repo, repoPath);
  } finally {
    db.close();
  }
}
import { runPause, runResume } from "./commands/pause.ts";
import { runRecommender } from "./commands/run-recommender.ts";
import { runStartCommand } from "./commands/start.ts";
import { runStatus } from "./commands/status.ts";
import { runStop } from "./commands/stop.ts";
import { runUninit } from "./commands/uninit.ts";

const VERSION = "0.0.0";

const program = new Command();
program
  .name("mm")
  .description("middle-management — autonomous GitHub issue dispatch")
  .version(VERSION);

program
  .command("init")
  .description("Bootstrap middle into a target repo (skills, hooks, config, state issue)")
  .argument("<path>", "path to the local repo checkout")
  .option("--dry-run", "print planned actions without executing")
  .action(async (path: string, options: { dryRun?: boolean }) =>
    process.exit(
      await runInit(path, { dryRun: options.dryRun, registerRepo: registerRepoInDaemonDb }),
    ),
  );

program
  .command("uninit")
  .description("Remove middle from a repo (reverse of `mm init`)")
  .argument("<path>", "path to the local repo checkout")
  .option("--dry-run", "print planned actions without executing")
  .action(async (path: string, options: { dryRun?: boolean }) =>
    process.exit(await runUninit(path, { dryRun: options.dryRun })),
  );

program
  .command("start")
  .description("Start the dispatcher process (hook server + workflow engine)")
  .option("--window", "open the queue observability page once the dispatcher is up")
  .action(async (options: { window?: boolean }) =>
    process.exit(await runStartCommand({ window: options.window })),
  );

program
  .command("stop")
  .description("Stop the dispatcher process")
  .action(() => process.exit(runStop()));

program
  .command("status")
  .description("One-screen summary of repos and workflow states")
  .action(() => process.exit(runStatus()));

program
  .command("doctor")
  .description("Check tmux/claude/git/gh preconditions for `mm dispatch`")
  .option("--fix", "write the bun PATH export to your shell rc (~/.zshrc / ~/.bashrc)")
  .action(async (options: { fix?: boolean }) =>
    process.exit(await runDoctor({ fix: options.fix })),
  );

program
  .command("dispatch")
  .description("Force-dispatch an Epic (or standalone issue) through the implementation workflow")
  .argument("<repo>", "path to the local repo checkout")
  .argument("<epic>", "Epic or standalone issue number")
  .action(async (repo: string, epic: string) => process.exit(await runDispatch(repo, epic)));

program
  .command("run-recommender")
  .description(
    "Trigger a recommender run for a repo (rewrites its state issue; read-only — dispatches nothing)",
  )
  .argument("<repo>", "path to the local repo checkout")
  .action(async (repo: string) => process.exit(await runRecommender(repo)));

program
  .command("pause")
  .description("Pause auto-dispatch for a repo (set repo_config.paused_until)")
  .argument("<repo>", "path to the local repo checkout")
  .action(async (repo: string) => process.exit(await runPause(repo)));

program
  .command("resume")
  .description("Resume auto-dispatch for a repo (clear its pause)")
  .argument("<repo>", "path to the local repo checkout")
  .action(async (repo: string) => process.exit(await runResume(repo)));

program
  .command("config")
  .description("Set a per-repo config value (e.g. auto_dispatch true)")
  .argument("<repo>", "path to the local repo checkout")
  .argument("<key>", "config key (e.g. auto_dispatch)")
  .argument("<value>", "the value to set")
  .action((repo: string, key: string, value: string) => process.exit(runConfig(repo, key, value)));

program
  .command("docs")
  .description(
    "Trigger a docs-harvester run for a repo (audits the docs surface; read-only — writes nothing)",
  )
  .argument("<repo>", "path to the local repo checkout")
  .action(async (repo: string) => process.exit(await runDocs(repo)));

program
  .command("audit-issues")
  .description(
    "Audit issue acceptance criteria against the integration rubric (Epic #143 requirements auditor)",
  )
  .argument("<repo>", "path to the local repo checkout")
  .option("--issue <n>", "audit a single GitHub issue by number")
  .option("--body-file <path>", "audit a local draft body before filing (no GitHub access)")
  .option("--title <title>", "title to pair with --body-file (anchors the suggested rewrite)")
  .option("--label", "apply the `needs-design` label to failing issues (GitHub modes)")
  .option("--json", "emit machine-readable JSON")
  .action(
    async (
      repo: string,
      options: {
        issue?: string;
        bodyFile?: string;
        title?: string;
        label?: boolean;
        json?: boolean;
      },
    ) =>
      process.exit(
        await runAuditIssues(repo, {
          issue: options.issue === undefined ? undefined : Number(options.issue),
          bodyFile: options.bodyFile,
          title: options.title,
          label: options.label,
          json: options.json,
        }),
      ),
  );

program
  .command("version")
  .description("Print the mm version")
  .action(() => {
    console.log(VERSION);
    process.exit(0);
  });

program.parseAsync(process.argv);
