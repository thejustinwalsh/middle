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
 *   `audit-issues`, `verify-file-mode`, `version`, `update`
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
import {
  assertNoRepoPathCollision,
  registerManagedRepo,
  setEpicStoreConfig,
} from "@middle/dispatcher/src/repo-config.ts";
import { runInit, type EpicStoreRegistration } from "./commands/init.ts";

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

/**
 * Persist a repo's Epic-store mode to the daemon db (#194) via
 * `setEpicStoreConfig` so the dispatcher's per-repo gateway selector routes it to
 * the file- or gh-backed gateways. Best-effort, like {@link registerRepoInDaemonDb}.
 */
function setEpicStoreInDaemonDb(repo: string, cfg: EpicStoreRegistration): void {
  const config = loadConfig({ globalPath: process.env.MIDDLE_CONFIG });
  const db = openAndMigrate(config.global.dbPath);
  try {
    setEpicStoreConfig(db, repo, cfg);
  } finally {
    db.close();
  }
}

/**
 * Shared-checkout collision guard (#226): reject `mm init` when this checkout path
 * is already registered to a *different* repo slug — BEFORE any files are written.
 * Throws {@link RepoPathCollisionError}; `runInit`'s catch turns it into a clear
 * `mm init: …` message + non-zero exit. NOT best-effort (a collision must fail).
 */
function checkRepoCollisionInDaemonDb(repo: string, repoPath: string): void {
  const config = loadConfig({ globalPath: process.env.MIDDLE_CONFIG });
  const db = openAndMigrate(config.global.dbPath);
  try {
    assertNoRepoPathCollision(db, repo, repoPath);
  } finally {
    db.close();
  }
}
import { runPause, runResume } from "./commands/pause.ts";
import { runResumeAnswer } from "./commands/resume-answer.ts";
import { runRecommender } from "./commands/run-recommender.ts";
import { runStartCommand } from "./commands/start.ts";
import { runStatus } from "./commands/status.ts";
import { runStop } from "./commands/stop.ts";
import { runUninit } from "./commands/uninit.ts";
import { runUpdate } from "./commands/update.ts";
import { runVerifyFileMode } from "./commands/verify-file-mode.ts";
import { formatVersion, resolveCliRoot, resolveGitProvenance } from "./commands/version.ts";

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
  .option(
    "--epic-store <mode>",
    "where Epics + recommender state live: 'github' (default) or 'file'",
    "github",
  )
  .action(async (path: string, options: { dryRun?: boolean; epicStore?: string }) => {
    const mode = options.epicStore ?? "github";
    if (mode !== "github" && mode !== "file") {
      console.error(`mm init: --epic-store must be 'github' or 'file' (got '${mode}')`);
      process.exit(1);
    }
    process.exit(
      await runInit(path, {
        dryRun: options.dryRun,
        epicStore: mode,
        registerRepo: registerRepoInDaemonDb,
        setEpicStore: setEpicStoreInDaemonDb,
        checkCollision: checkRepoCollisionInDaemonDb,
      }),
    );
  });

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
  .option("--foreground", "run in the foreground without a pid file (for systemd/launchd)")
  .action(async (options: { window?: boolean; foreground?: boolean }) =>
    process.exit(await runStartCommand({ window: options.window, foreground: options.foreground })),
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
  .option(
    "--vocabulary-check",
    "only check docs/vocabulary.md agrees with middle's label constants",
  )
  .action(async (options: { fix?: boolean; vocabularyCheck?: boolean }) =>
    process.exit(await runDoctor({ fix: options.fix, vocabularyCheck: options.vocabularyCheck })),
  );

program
  .command("dispatch")
  .description("Force-dispatch an Epic (or standalone issue) through the implementation workflow")
  .argument("<repo>", "path to the local repo checkout")
  .argument("[epic]", "Epic ref — a file-mode slug or a github issue number (or use --epic)")
  .option("--epic <ref>", "Epic ref (alternative to the positional <epic>; a slug or a number)")
  .option(
    "--adapter <name>",
    "adapter to dispatch with (overrides the agent:<name> label and default)",
  )
  .action(
    async (repo: string, epic: string | undefined, opts: { epic?: string; adapter?: string }) => {
      const ref = epic ?? opts.epic;
      if (ref === undefined) {
        console.error("mm dispatch: provide an epic ref (positional <epic> or --epic <ref>)");
        process.exit(1);
      }
      process.exit(await runDispatch(repo, ref, { adapter: opts.adapter }));
    },
  );

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
  .description(
    "Resume a repo's auto-dispatch (clear its pause), or — with <epic> --answer — unblock a parked Epic",
  )
  .argument("<repo>", "path to the local repo checkout")
  .argument("[epic]", "Epic ref to unblock (a slug or number); omit to clear the repo's pause")
  .option("--answer <text>", "human answer that resumes the parked Epic")
  .action(async (repo: string, epic: string | undefined, opts: { answer?: string }) => {
    // `mm resume <repo> <epic> --answer "…"` fires the parked Epic's resume
    // signal; the bare `mm resume <repo>` keeps clearing the repo's pause.
    if (epic !== undefined || opts.answer !== undefined) {
      if (epic === undefined || opts.answer === undefined) {
        console.error("mm resume: unblocking a parked Epic needs both <epic> and --answer <text>");
        process.exit(1);
      }
      process.exit(await runResumeAnswer(repo, epic, opts.answer));
    }
    process.exit(await runResume(repo));
  });

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
    ) => {
      // Require a canonical positive integer. `Number.parseInt` would silently
      // accept trailing garbage ("12abc" → 12), so validate the raw string first.
      if (options.issue !== undefined && !/^[1-9]\d*$/.test(options.issue)) {
        console.error("mm audit-issues: --issue must be a positive integer");
        process.exit(1);
        return;
      }
      const issue = options.issue === undefined ? undefined : Number.parseInt(options.issue, 10);
      process.exit(
        await runAuditIssues(repo, {
          issue,
          bodyFile: options.bodyFile,
          title: options.title,
          label: options.label,
          json: options.json,
        }),
      );
    },
  );

program
  .command("verify-file-mode")
  .description(
    "Verify file mode end-to-end: drive the real file-mode workflow over a throwaway fixture and print a structured report",
  )
  .option("--live", "run the real-GitHub smoke against a designated test repo (needs --repo)")
  .option("--repo <owner/name>", "the throwaway test repo for --live")
  .option("--repo-path <path>", "local checkout of the --live test repo (defaults to cwd)")
  .action(async (options: { live?: boolean; repo?: string; repoPath?: string }) =>
    process.exit(
      await runVerifyFileMode({
        live: options.live,
        repo: options.repo,
        repoPath: options.repoPath,
      }),
    ),
  );

program
  .command("version")
  .description("Print the mm version (with git sha+branch when installed from a git checkout)")
  .action(async () => {
    const root = await resolveCliRoot(import.meta.dir);
    const provenance = root !== null ? await resolveGitProvenance(root) : null;
    console.log(formatVersion(VERSION, provenance));
    process.exit(0);
  });

program
  .command("update")
  .description(
    "Pull the latest commits and re-install dependencies (only when on main with a clean tree)",
  )
  .action(async () => {
    process.exit(await runUpdate());
  });

program.parseAsync(process.argv);
