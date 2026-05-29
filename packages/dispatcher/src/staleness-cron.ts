import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
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
 * The repo-relative build-spec path the drift check reads. A default convention;
 * a repo without this file simply gets the landed-issue reconcile and no drift
 * check (the spec read returns null).
 */
export const DEFAULT_SPEC_PATH = join("planning", "middle-management-build-spec.md");

/**
 * Dependencies for a staleness cron pass over the managed-repo registry: the
 * SQLite handle the registry lives in, the GitHub gateway each repo's
 * reconciliation reads/mutates, and the spec path + clock (both injectable for
 * tests).
 */
export type StalenessCronDeps = {
  /** The dispatcher DB holding the managed-repo registry. */
  db: Database;
  github: Pick<
    GitHubGateway,
    "listOpenIssues" | "listMergedPrsClosingRefs" | "closeIssue" | "createIssue"
  >;
  /** The build-spec path, repo-relative (default {@link DEFAULT_SPEC_PATH}). */
  specPath?: string;
  /** Injectable clock for the paused-repo check (default `Date.now`). */
  now?: () => number;
};

/**
 * One reconciliation pass over the managed-repo registry: for each managed,
 * non-paused repo, run {@link reconcileStaleness} (close landed-but-open issues,
 * flag spec drift). Per-repo failures are isolated. Returns the total number of
 * issues closed across all repos.
 */
export async function runStalenessCronPass(deps: StalenessCronDeps): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const specPath = deps.specPath ?? DEFAULT_SPEC_PATH;
  let closed = 0;
  for (const managed of listManagedRepos(deps.db)) {
    if (isPaused(deps.db, managed.repo, now)) continue;
    try {
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
