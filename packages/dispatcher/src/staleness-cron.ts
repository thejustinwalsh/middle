import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Database } from "bun:sqlite";
import { loadConfig } from "@middle/core";
import { Bunqueue } from "bunqueue/client";
import type { GitHubGateway } from "./github.ts";
import { isPaused, listManagedRepos } from "./repo-config.ts";
import { reconcileStaleness } from "./staleness.ts";

/**
 * Sweep cadence for anti-staleness reconciliation (Epic #143, sub-issue #146).
 * Like the backlog audit it is not latency-sensitive — issues/spec going stale is
 * a slow drift — so an hourly sweep is plenty.
 */
export const STALENESS_CRON_INTERVAL_MS = 60 * 60_000;

/**
 * The repo-relative build-spec path the drift check reads when a repo declares no
 * `[staleness] spec_path`. A default convention; a repo without this file simply
 * gets the landed-issue reconcile and no drift check (the spec read returns null).
 */
export const DEFAULT_SPEC_PATH = join("planning", "middle-management-build-spec.md");

/**
 * Dependencies for a staleness cron pass over the managed-repo registry: the
 * SQLite handle the registry lives in, the GitHub gateway each repo's
 * reconciliation reads/mutates, and the global-config path + clock (both
 * injectable for tests).
 */
export type StalenessCronDeps = {
  /** The dispatcher DB holding the managed-repo registry. */
  db: Database;
  github: Pick<
    GitHubGateway,
    "listOpenIssues" | "listMergedPrsClosingRefs" | "closeIssue" | "createIssue"
  >;
  /**
   * The global config path threaded into each repo's config load — the daemon
   * passes `process.env.MIDDLE_CONFIG` so per-repo loads see the same global layer
   * `mm start` booted with. Each repo's spec path comes from its own merged config
   * (`[staleness] spec_path` in `.middle/config.toml`/`policy.toml`), falling back
   * to {@link DEFAULT_SPEC_PATH}. Omit (or point at a missing file) for defaults.
   */
  globalConfigPath?: string;
  /** Injectable clock for the paused-repo check (default `Date.now`). */
  now?: () => number;
};

/**
 * Resolve a repo's build-spec path from its merged config (`[staleness] spec_path`
 * in `.middle/config.toml`/`policy.toml`, layered on the daemon's global config),
 * falling back to {@link DEFAULT_SPEC_PATH} when unset. Reading config can throw on
 * a malformed TOML; callers run it inside the per-repo guard so one bad config
 * logs-and-continues rather than aborting the sweep.
 *
 * `spec_path` is repo-relative by contract and is later joined onto the checkout
 * and read off disk, so it is **constrained to the checkout**: an absolute path or
 * one that escapes via `..` throws here (caught by the per-repo guard as that
 * repo's logged failure) rather than letting a committed/local config read files
 * outside the repo. The returned value stays repo-relative — `readSpec` joins it
 * onto the checkout and the reconcile-task body names it verbatim.
 */
function resolveSpecPath(checkoutPath: string, globalConfigPath: string | undefined): string {
  const config = loadConfig({
    globalPath: globalConfigPath,
    repoPath: join(checkoutPath, ".middle", "config.toml"),
  });
  const specPath = config.staleness?.specPath ?? DEFAULT_SPEC_PATH;
  // Bound it to the checkout. `relative` of the resolved pair tells us whether the
  // target stays inside: a `..`-only segment or `..<sep>` prefix means it climbed
  // out, and an absolute result means `specPath` was itself absolute. A literal
  // segment like `..foo` is NOT an escape, so match the `..` segment exactly rather
  // than a naive `startsWith("..")` that would also reject such names.
  const rel = relative(checkoutPath, join(checkoutPath, specPath));
  if (isAbsolute(specPath) || rel === ".." || rel.startsWith(".." + sep)) {
    throw new Error(`[staleness] spec_path escapes the repo checkout: ${specPath}`);
  }
  return specPath;
}

/**
 * One reconciliation pass over the managed-repo registry: for each managed,
 * non-paused repo, run {@link reconcileStaleness} (close landed-but-open issues,
 * flag spec drift) against that repo's configured (or default) spec path. Per-repo
 * failures are isolated. Returns the total number of issues closed across all repos.
 */
export async function runStalenessCronPass(deps: StalenessCronDeps): Promise<number> {
  const now = (deps.now ?? Date.now)();
  let closed = 0;
  for (const managed of listManagedRepos(deps.db)) {
    if (isPaused(deps.db, managed.repo, now)) continue;
    try {
      // Inside the guard: a malformed per-repo config.toml shouldn't abort the
      // whole sweep — it logs as that repo's failure and the others still run.
      const specPath = resolveSpecPath(managed.checkoutPath, deps.globalConfigPath);
      const result = await reconcileStaleness({
        repo: managed.repo,
        github: deps.github,
        specPath,
        readSpec: () => {
          try {
            return readFileSync(join(managed.checkoutPath, specPath), "utf8");
          } catch (error) {
            // Only a genuinely-absent spec means "skip the drift check". A
            // permission/I/O error (EACCES, EISDIR, …) is a real failure and must
            // surface — swallowing it would silently disable drift detection.
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          }
        },
      });
      closed += result.closed.length;
    } catch (error) {
      console.error(`[staleness] ${managed.repo} pass failed: ${(error as Error).message}`);
    }
  }
  return closed;
}

/**
 * Stand up the anti-staleness cron as a bunqueue cron (mirrors `startAuditCron` /
 * `startRecommenderCron`): every `intervalMs` (default
 * {@link STALENESS_CRON_INTERVAL_MS}) it runs one {@link runStalenessCronPass}.
 * Returns a stop function. Guards the whole pass so a throw never crashes the worker.
 */
export async function startStalenessCron(
  deps: StalenessCronDeps,
  intervalMs: number = STALENESS_CRON_INTERVAL_MS,
): Promise<() => Promise<void>> {
  const queue = new Bunqueue("middle-staleness-cron", {
    embedded: true,
    processor: async () => {
      try {
        await runStalenessCronPass(deps);
      } catch (error) {
        console.error(`[staleness] pass failed: ${(error as Error).message}`);
      }
    },
  });
  await queue.every("staleness-tick", intervalMs);
  return async () => {
    await queue.close(true);
  };
}
