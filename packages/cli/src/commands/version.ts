import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Result of a git spawn (stdout text + exit code). */
export type GitSpawnResult = { stdout: string; exitCode: number };

/** Injected git executor — defaults to spawning real git; override in tests. */
export type GitSpawn = (args: string[], cwd: string) => Promise<GitSpawnResult>;

/** Git provenance resolved from the CLI's repo root. */
export type GitProvenance = {
  sha: string;
  branch: string;
  dirty: boolean;
};

/** Options accepted by {@link resolveGitProvenance}. */
export type ResolveProvenanceOptions = {
  /** Override git spawner for testing. */
  spawnGit?: (args: string[], cwd?: string) => Promise<GitSpawnResult>;
};

/**
 * Walk up from `startDir` looking for a `.git` directory or file (worktrees
 * use a `.git` file). Returns the path that CONTAINS `.git`, or null when no
 * ancestor has one.
 *
 * Used by `mm version` to find the CLI's own repo root when the `mm` bin is a
 * symlink into the repo source (`bun link` install).
 */
export async function resolveCliRoot(startDir: string): Promise<string | null> {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

/**
 * Resolve git provenance (sha, branch, dirty flag) for the repo at `root`.
 *
 * Returns null when `root` is not a git repository (e.g. a packaged install).
 * All git calls go through `opts.spawnGit` so tests can inject results.
 */
export async function resolveGitProvenance(
  root: string,
  opts: ResolveProvenanceOptions = {},
): Promise<GitProvenance | null> {
  const spawn: (args: string[], cwd?: string) => Promise<GitSpawnResult> =
    opts.spawnGit ??
    (async (args, cwd) => {
      const proc = Bun.spawn(["git", ...args], {
        cwd: cwd ?? root,
        stdout: "pipe",
        stderr: "ignore",
      });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      return { stdout, exitCode };
    });

  // Resolve short SHA — failure means this is not a git repo.
  const shaResult = await spawn(["rev-parse", "--short", "HEAD"], root);
  if (shaResult.exitCode !== 0) return null;
  const sha = shaResult.stdout.trim();

  // Resolve branch name (detached HEAD gives the SHA again — fine).
  const branchResult = await spawn(["branch", "--show-current"], root);
  const branch = branchResult.stdout.trim() || sha;

  // Check for uncommitted changes (--porcelain output = dirty).
  const statusResult = await spawn(["status", "--porcelain"], root);
  const dirty = statusResult.stdout.trim().length > 0;

  return { sha, branch, dirty };
}

/**
 * Format the `mm version` output line.
 *
 * - With provenance: `mm <version> (<sha>[-dirty], <branch>)`
 * - Without (not a git checkout): `mm <version>`
 */
export function formatVersion(version: string, provenance: GitProvenance | null): string {
  if (provenance === null) return `mm ${version}`;
  const shaTag = provenance.dirty ? `${provenance.sha}-dirty` : provenance.sha;
  return `mm ${version} (${shaTag}, ${provenance.branch})`;
}
