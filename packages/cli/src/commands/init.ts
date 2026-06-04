import { resolve } from "node:path";
import {
  FILE_EPICS_DIR,
  FILE_STATE_FILE,
  initRepo,
  realDeps,
  type BootstrapDeps,
  type EpicStoreMode,
} from "../bootstrap/index.ts";

/** A repo's Epic-store config as recorded in the daemon db (mirrors `EpicStoreConfig`). */
export type EpicStoreRegistration =
  | { mode: "github" }
  | { mode: "file"; epicsDir: string; stateFile: string };

export type InitCliOptions = {
  dryRun?: boolean;
  /**
   * Epic-store mode (#194): `"github"` (default) keeps today's state-issue flow;
   * `"file"` scaffolds a local Epic store and makes no GitHub calls.
   */
  epicStore?: EpicStoreMode;
  /** Injectable for tests; defaults to the gh/git-backed deps. */
  deps?: BootstrapDeps;
  /**
   * Record the repo in the daemon's managed-repo registry (#135) so the
   * recommender cron picks it up cold — wired by the CLI entry to a db write;
   * injectable for tests. Omitted → no registration (e.g. unit tests).
   */
  registerRepo?: (repo: string, repoPath: string) => void;
  /**
   * Persist the repo's Epic-store mode to the daemon db (#194) — wired by the CLI
   * entry to `setEpicStoreConfig`; injectable for tests. Called for every mode
   * (including `"github"`) so a re-init can flip the mode. Best-effort, like
   * `registerRepo`. Omitted → no write (e.g. unit tests that don't assert it).
   */
  setEpicStore?: (repo: string, cfg: EpicStoreRegistration) => void;
  /**
   * Shared-checkout collision guard (#226) — wired by the CLI entry to a daemon-db
   * lookup (`assertNoRepoPathCollision`). Run *before* any files are written (so a
   * rejected init scaffolds nothing) with the resolved `owner/name` slug + the
   * checkout path; a throw aborts the init with a non-zero exit. Unlike
   * `registerRepo`/`setEpicStore`, this is NOT best-effort — a collision must fail
   * the init. Omitted → no guard (unit tests that don't assert it).
   */
  checkCollision?: (repo: string, repoPath: string) => void;
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
    const result = await initRepo(repo, deps, {
      dryRun: opts.dryRun ?? false,
      epicStore: opts.epicStore ?? "github",
      // The guard runs inside initRepo (after the slug resolves, before any write)
      // so a collision aborts the init before it scaffolds. The throw propagates to
      // the catch below → `mm init: <message>` on stderr, non-zero exit (#226).
      checkCollision: opts.checkCollision ? (slug) => opts.checkCollision!(slug, repo) : undefined,
    });
    const slug = `${result.info.owner}/${result.info.name}`;

    if (result.dryRun) {
      console.log(`mm init (dry run) — ${slug} [${result.mode}, ${result.epicStore}]\n`);
      for (const action of result.actions) console.log(`  • ${action}`);
      console.log("\nno changes made.");
      return 0;
    }

    console.log(
      `✓ middle initialized for ${slug}${result.mode === "fresh" ? "" : ` [${result.mode}]`}`,
    );
    console.log("  skills installed at .claude/skills/, .codex/skills/");
    console.log("  hook script at .middle/hooks/hook.sh");
    if (result.epicStore === "file") {
      console.log(`  epic store: file (Epics in ${FILE_EPICS_DIR}/, state in ${FILE_STATE_FILE})`);
    } else {
      const issueLine =
        result.mode === "fresh"
          ? `state issue created: #${result.stateIssue}`
          : `state issue: #${result.stateIssue} (kept)`;
      console.log(`  ${issueLine}`);
    }
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

    // Persist the Epic-store mode to the daemon db (#194) so the bootstrap
    // selector routes this repo to the file- or gh-backed gateways. Best-effort,
    // for the same reason as the managed-repo registry write above.
    try {
      opts.setEpicStore?.(
        slug,
        result.epicStore === "file"
          ? { mode: "file", epicsDir: FILE_EPICS_DIR, stateFile: FILE_STATE_FILE }
          : { mode: "github" },
      );
    } catch (error) {
      console.error(`  (note: epic-store config write skipped — ${(error as Error).message})`);
    }
    return 0;
  } catch (error) {
    console.error(`mm init: ${(error as Error).message}`);
    return 1;
  }
}
