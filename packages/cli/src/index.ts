#!/usr/bin/env bun
// @middle/cli — the `mm` binary. commander wiring over the command functions.
import { Command } from "commander";
import { runDispatch } from "./commands/dispatch.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runStart } from "./commands/start.ts";
import { runStatus } from "./commands/status.ts";
import { runStop } from "./commands/stop.ts";

const VERSION = "0.0.0";

const program = new Command();
program
  .name("mm")
  .description("middle-management — autonomous GitHub issue dispatch")
  .version(VERSION);

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
  .command("version")
  .description("Print the mm version")
  .action(() => {
    console.log(VERSION);
    process.exit(0);
  });

program.parseAsync(process.argv);
