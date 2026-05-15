import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

/**
 * git worktree helpers. Concurrent workflows are isolated by one git worktree
 * each, under `~/.middle/worktrees/<repo>/issue-<n>/` (or `.../recommender/`).
 * Helpers shell out to `git` and surface real failures as `WorktreeError`; the
 * already-exists and already-removed cases are handled idempotently.
 */
export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

export type WorktreeHandle = {
  /** The main repo checkout this worktree belongs to. */
  repoPath: string;
  /** Absolute path of the worktree directory. */
  path: string;
  /** The fresh branch checked out in the worktree. */
  branch: string;
  /** 'owner/name' — the dispatched repo. */
  repo: string;
  /** 'issue-<n>' for a dispatch unit, 'recommender' for the recommender. */
  unit: string;
};

export type CreateWorktreeOpts = {
  /** Path to the main repo checkout. */
  repoPath: string;
  /** 'owner/name' — drives the worktree directory layout. */
  repo: string;
  /** Issue/Epic number; omit for the recommender. */
  issueNumber?: number;
  /** Root for all worktrees; defaults to `~/.middle/worktrees`. */
  worktreeRoot?: string;
  /** Branch name; defaults to `middle-<unit>`. */
  branch?: string;
};

function defaultRoot(): string {
  return join(homedir(), ".middle", "worktrees");
}

function unitName(issueNumber?: number): string {
  return issueNumber === undefined ? "recommender" : `issue-${issueNumber}`;
}

/** Resolve the root to a real path, creating it if absent — keeps path comparisons honest. */
function resolveRoot(worktreeRoot: string | undefined): string {
  const root = worktreeRoot ?? defaultRoot();
  mkdirSync(root, { recursive: true });
  return realpathSync(root);
}

type RawWorktree = { path: string; branch: string | null };

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exitCode: await proc.exited };
}

/** Parse `git worktree list --porcelain` into path + branch records. */
function parsePorcelain(stdout: string): RawWorktree[] {
  const out: RawWorktree[] = [];
  let current: RawWorktree | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null };
      out.push(current);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }
  return out;
}

async function rawList(repoPath: string): Promise<RawWorktree[]> {
  const result = await runGit(repoPath, ["worktree", "list", "--porcelain"]);
  if (result.exitCode !== 0) {
    throw new WorktreeError(`git worktree list failed: ${result.stderr.trim()}`);
  }
  return parsePorcelain(result.stdout);
}

function toHandle(repoPath: string, root: string, raw: RawWorktree): WorktreeHandle {
  const rel = relative(root, raw.path);
  const segments = rel.split(sep);
  const unit = segments.pop() ?? rel;
  return {
    repoPath,
    path: raw.path,
    branch: raw.branch ?? "",
    repo: segments.join("/"),
    unit,
  };
}

/**
 * Create a worktree for a dispatch unit on a fresh branch. Idempotent: if the
 * worktree is already registered, the existing handle is returned rather than
 * re-running `git worktree add`.
 */
export async function createWorktree(opts: CreateWorktreeOpts): Promise<WorktreeHandle> {
  const repoPath = realpathSync(opts.repoPath);
  const root = resolveRoot(opts.worktreeRoot);
  const unit = unitName(opts.issueNumber);
  const path = join(root, opts.repo, unit);
  const branch = opts.branch ?? `middle-${unit}`;
  const handle: WorktreeHandle = { repoPath, path, branch, repo: opts.repo, unit };

  const existing = await rawList(repoPath);
  if (existing.some((w) => w.path === path)) return handle;

  mkdirSync(dirname(path), { recursive: true });
  const result = await runGit(repoPath, ["worktree", "add", path, "-b", branch]);
  if (result.exitCode !== 0) {
    throw new WorktreeError(`git worktree add failed: ${result.stderr.trim()}`);
  }
  return handle;
}

/**
 * Remove a worktree and its branch, including the directory. Idempotent: an
 * already-removed worktree and an already-deleted branch are both skipped
 * silently; only an unexpected `git` failure surfaces as `WorktreeError`.
 */
export async function destroyWorktree(handle: WorktreeHandle): Promise<void> {
  const registered = await rawList(handle.repoPath);
  if (registered.some((w) => w.path === handle.path)) {
    const result = await runGit(handle.repoPath, [
      "worktree",
      "remove",
      "--force",
      handle.path,
    ]);
    if (result.exitCode !== 0) {
      throw new WorktreeError(`git worktree remove failed: ${result.stderr.trim()}`);
    }
  }

  if (handle.branch) {
    const branchCheck = await runGit(handle.repoPath, [
      "rev-parse",
      "--verify",
      `refs/heads/${handle.branch}`,
    ]);
    if (branchCheck.exitCode === 0) {
      await runGit(handle.repoPath, ["branch", "-D", handle.branch]);
    }
  }

  if (existsSync(handle.path)) {
    rmSync(handle.path, { recursive: true, force: true });
  }
}

/** Enumerate the active worktrees registered to `repoPath` that live under the root. */
export async function listWorktrees(opts: {
  repoPath: string;
  worktreeRoot?: string;
}): Promise<WorktreeHandle[]> {
  const repoPath = realpathSync(opts.repoPath);
  const root = resolveRoot(opts.worktreeRoot);
  const raw = await rawList(repoPath);
  return raw
    .filter((w) => w.path.startsWith(root + sep))
    .map((w) => toHandle(repoPath, root, w));
}
