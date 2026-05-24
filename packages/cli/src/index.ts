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
 *   `dispatch`, `run-recommender`, `docs`, `version`
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
import { runDispatch } from "./commands/dispatch.ts";
import { runDocs } from "./commands/docs.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runInit } from "./commands/init.ts";
import { runRecommender } from "./commands/run-recommender.ts";
import { runStart } from "./commands/start.ts";
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
    process.exit(await runInit(path, { dryRun: options.dryRun })),
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
  .action(() => process.exit(runStart()));

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
  .action(async () => process.exit(await runDoctor()));

program
  .command("dispatch")
  .description("Force-dispatch an Epic (or standalone issue) through the implementation workflow")
  .argument("<repo>", "path to the local repo checkout")
  .argument("<epic>", "Epic or standalone issue number")
  .action(async (repo: string, epic: string) => process.exit(await runDispatch(repo, epic)));

program
  .command("run-recommender")
  .description("Trigger a recommender run for a repo (rewrites its state issue; read-only — dispatches nothing)")
  .argument("<repo>", "path to the local repo checkout")
  .action(async (repo: string) => process.exit(await runRecommender(repo)));

program
  .command("docs")
  .description("Trigger a docs-harvester run for a repo (audits the docs surface; read-only — writes nothing)")
  .argument("<repo>", "path to the local repo checkout")
  .action(async (repo: string) => process.exit(await runDocs(repo)));

program
  .command("version")
  .description("Print the mm version")
  .action(() => {
    console.log(VERSION);
    process.exit(0);
  });

program.parseAsync(process.argv);
