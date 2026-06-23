import { formatVersion, resolveCliRoot, resolveGitProvenance } from "./version.ts";

/** Result from a spawned process (exit code only — stdout is not needed). */
export type SpawnResult = { exitCode: number };

/** Injected spawn helpers — override in tests to avoid touching a real repo. */
export type UpdateOptions = {
  /** Override the CLI repo root (resolved via import.meta at runtime). */
  cliRoot?: string;
  /** Override git spawner. */
  spawnGit?: (args: string[], cwd?: string) => Promise<{ stdout: string; exitCode: number }>;
  /** Override bun spawner. */
  spawnBun?: (args: string[], cwd?: string) => Promise<SpawnResult>;
};

/** The default branch name that `mm update` requires. */
const DEFAULT_BRANCH = "main";

/** Current mm version — kept in sync with the VERSION constant in index.ts. */
const VERSION = "0.0.0";

/**
 * `mm update` — pull the latest commits and re-install dependencies.
 *
 * Safety rules (load-bearing — mm is often linked to a dev checkout):
 * 1. If the working tree is dirty → refuse with a clear message.
 * 2. If not on `main` → refuse with a clear message.
 *
 * On the happy path: `git pull --ff-only`, `bun install`, then print the new
 * `mm version` line. Returns a process exit code.
 */
export async function runUpdate(opts: UpdateOptions = {}): Promise<number> {
  // ---------------------------------------------------------------------------
  // Resolve the CLI's own repo root from the symlinked bin at runtime.
  // In tests, opts.cliRoot is injected directly.
  // ---------------------------------------------------------------------------
  const cliRoot =
    opts.cliRoot ??
    (await resolveCliRoot(
      // import.meta.dir resolves through symlinks into the real source tree.
      import.meta.dir,
    ));

  if (cliRoot === null) {
    console.error(
      "mm update: cannot locate the mm repo root — " +
        "mm appears not to be installed from a git checkout. Update manually.",
    );
    return 1;
  }

  const spawnGit: (args: string[], cwd?: string) => Promise<{ stdout: string; exitCode: number }> =
    opts.spawnGit ??
    (async (args, cwd) => {
      const proc = Bun.spawn(["git", ...args], {
        cwd: cwd ?? cliRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      return { stdout, exitCode };
    });

  const spawnBun: (args: string[], cwd?: string) => Promise<SpawnResult> =
    opts.spawnBun ??
    (async (args, cwd) => {
      const proc = Bun.spawn(["bun", ...args], {
        cwd: cwd ?? cliRoot,
        stdout: "inherit",
        stderr: "inherit",
      });
      const exitCode = await proc.exited;
      return { exitCode };
    });

  // ---------------------------------------------------------------------------
  // Safety check 1: current branch
  // ---------------------------------------------------------------------------
  const branchResult = await spawnGit(["rev-parse", "--abbrev-ref", "HEAD"], cliRoot);
  const branch = branchResult.stdout.trim();
  if (branch !== DEFAULT_BRANCH) {
    console.error(
      `mm update: mm is linked to ${cliRoot} on branch ${branch} — ` +
        `update manually with: git -C ${cliRoot} checkout ${DEFAULT_BRANCH} && git pull`,
    );
    return 1;
  }

  // ---------------------------------------------------------------------------
  // Safety check 2: working tree clean
  // ---------------------------------------------------------------------------
  const statusResult = await spawnGit(["status", "--porcelain"], cliRoot);
  const isDirty = statusResult.stdout.trim().length > 0;
  if (isDirty) {
    console.error(
      `mm update: mm is linked to ${cliRoot} with uncommitted changes — ` +
        `update manually with: git -C ${cliRoot} stash && git pull`,
    );
    return 1;
  }

  // ---------------------------------------------------------------------------
  // Happy path: pull + install
  // ---------------------------------------------------------------------------
  console.log(`mm update: pulling latest from ${cliRoot} …`);
  const pullResult = await spawnGit(["pull", "--ff-only"], cliRoot);
  if (pullResult.exitCode !== 0) {
    console.error(
      `mm update: git pull --ff-only failed (exit ${pullResult.exitCode}) — ` +
        `resolve the conflict manually in ${cliRoot}`,
    );
    return 1;
  }

  console.log("mm update: installing dependencies …");
  const installResult = await spawnBun(["install"], cliRoot);
  if (installResult.exitCode !== 0) {
    console.error(`mm update: bun install failed (exit ${installResult.exitCode})`);
    return 1;
  }

  // ---------------------------------------------------------------------------
  // Print the new version line (re-resolve provenance after the pull).
  // ---------------------------------------------------------------------------
  const provenance = await resolveGitProvenance(cliRoot, { spawnGit });
  console.log(formatVersion(VERSION, provenance));
  return 0;
}
