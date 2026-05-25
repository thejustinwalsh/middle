import { homedir } from "node:os";
import { basename, join } from "node:path";

/** middle's per-user home — `~/.middle`. */
export function middleHome(): string {
  return join(homedir(), ".middle");
}

/** Where `mm start` records the dispatcher process id for `mm stop` to find. */
export function defaultPidFile(): string {
  return join(middleHome(), "dispatcher.pid");
}

/**
 * Derive an `owner/name` slug from a repo checkout's `origin` remote, falling
 * back to its directory name. This is the same key the dispatcher's workflows
 * and `repo_config` rows use (a manual dispatch / recommender run resolves the
 * slug the same way), so DB-keyed commands like `mm pause` must derive it
 * identically or they'd write a row the auto-dispatch loop never reads.
 */
export async function deriveRepoSlug(repoPath: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repoPath, "remote", "get-url", "origin"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const url = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) === 0 && url) {
    const match = /[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
    if (match) return match[1]!;
  }
  return basename(repoPath);
}
