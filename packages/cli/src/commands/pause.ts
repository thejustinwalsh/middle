import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@middle/core";
import { openAndMigrate } from "@middle/dispatcher/src/db.ts";
import { clearPaused, setPausedUntil } from "@middle/dispatcher/src/repo-config.ts";
import { deriveRepoSlug } from "../paths.ts";

export type PauseResumeOptions = {
  /** Override the global config path (defaults to `~/.middle/config.toml`). */
  configPath?: string;
  /** Override the database path (defaults to the config's `db_path`). */
  dbPath?: string;
  /** Resolve the repo's `owner/name` slug (defaults to the git-remote derivation). */
  resolveSlug?: (repoPath: string) => Promise<string>;
};

/** Resolve the db path + the repo slug shared by `mm pause` and `mm resume`. */
async function resolve(
  command: string,
  repoPath: string,
  opts: PauseResumeOptions,
): Promise<{ dbPath: string; repo: string } | null> {
  if (!existsSync(join(repoPath, ".git"))) {
    console.error(`mm ${command}: "${repoPath}" is not a git repository`);
    return null;
  }
  let dbPath: string;
  try {
    dbPath = opts.dbPath ?? loadConfig({ globalPath: opts.configPath }).global.dbPath;
  } catch (error) {
    console.error(`mm ${command}: failed to load config — ${(error as Error).message}`);
    return null;
  }
  const repo = await (opts.resolveSlug ?? deriveRepoSlug)(repoPath);
  return { dbPath, repo };
}

/**
 * `mm pause <repo>` — suspend auto-dispatch for a repo by setting its
 * `repo_config.paused_until`. With no duration the pause is indefinite (cleared
 * by `mm resume`). The auto-dispatch loop skips a paused repo. Returns a process
 * exit code: 0 on success, 1 on error.
 */
export async function runPause(repoPath: string, opts: PauseResumeOptions = {}): Promise<number> {
  const resolved = await resolve("pause", repoPath, opts);
  if (!resolved) return 1;
  const db = openAndMigrate(resolved.dbPath);
  try {
    setPausedUntil(db, resolved.repo);
    console.log(`mm pause: ${resolved.repo} auto-dispatch paused (resume with \`mm resume\`)`);
    return 0;
  } catch (error) {
    console.error(`mm pause: ${(error as Error).message}`);
    return 1;
  } finally {
    db.close();
  }
}

/**
 * `mm resume <repo>` — clear a repo's pause (`repo_config.paused_until`), so the
 * auto-dispatch loop considers it again. A no-op if the repo was never paused.
 * Returns a process exit code: 0 on success, 1 on error.
 */
export async function runResume(repoPath: string, opts: PauseResumeOptions = {}): Promise<number> {
  const resolved = await resolve("resume", repoPath, opts);
  if (!resolved) return 1;
  const db = openAndMigrate(resolved.dbPath);
  try {
    clearPaused(db, resolved.repo);
    console.log(`mm resume: ${resolved.repo} auto-dispatch resumed`);
    return 0;
  } catch (error) {
    console.error(`mm resume: ${(error as Error).message}`);
    return 1;
  } finally {
    db.close();
  }
}
