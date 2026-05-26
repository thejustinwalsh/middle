import type { Database } from "bun:sqlite";
import { Bunqueue } from "bunqueue/client";
import { runBacklogAudit } from "./audit.ts";
import type { GitHubGateway } from "./github.ts";
import { isPaused, listManagedRepos } from "./repo-config.ts";

/**
 * Sweep cadence for the standing backlog audit (Epic #143, sub-issue #144). It is
 * not latency-sensitive — weak acceptance criteria don't need flagging within
 * seconds — and each pass is a single issue-list read plus a label edit per new
 * failure, so an hourly sweep is plenty. Much gentler than the watchdog (30s).
 */
export const AUDIT_CRON_INTERVAL_MS = 60 * 60_000;

/**
 * Collaborators the audit cron needs, as injectable seams. The daemon wires `db`
 * (for the managed-repo registry) and the gh-backed gateway; tests stub both.
 */
export type AuditCronDeps = {
  db: Database;
  github: Pick<GitHubGateway, "listOpenIssues" | "addLabel">;
  now?: () => number;
};

/**
 * One audit pass over the managed-repo registry: for each managed, non-paused
 * repo, run {@link runBacklogAudit} (label rubric-failing feature issues
 * `needs-design`). Per-repo failures are isolated and retried next sweep. Returns
 * the total number of issues newly flagged across all repos.
 */
export async function runAuditCronPass(deps: AuditCronDeps): Promise<number> {
  const now = (deps.now ?? Date.now)();
  let flagged = 0;
  for (const managed of listManagedRepos(deps.db)) {
    if (isPaused(deps.db, managed.repo, now)) continue;
    try {
      const { flagged: f } = await runBacklogAudit({ repo: managed.repo, github: deps.github });
      flagged += f.length;
    } catch (error) {
      console.error(`[backlog-audit] ${managed.repo} sweep failed: ${(error as Error).message}`);
    }
  }
  return flagged;
}

/**
 * Stand up the backlog-audit cron as a bunqueue cron (mirrors `startRecommenderCron`):
 * every `intervalMs` (default {@link AUDIT_CRON_INTERVAL_MS}) it runs one
 * {@link runAuditCronPass}. Returns a stop function. The pass isolates per-repo
 * failures; this wrapper guards the whole pass too so a throw never crashes the worker.
 */
export async function startAuditCron(
  deps: AuditCronDeps,
  intervalMs: number = AUDIT_CRON_INTERVAL_MS,
): Promise<() => Promise<void>> {
  const queue = new Bunqueue("middle-backlog-audit-cron", {
    embedded: true,
    processor: async () => {
      try {
        await runAuditCronPass(deps);
      } catch (error) {
        console.error(`[backlog-audit] pass failed: ${(error as Error).message}`);
      }
    },
  });
  await queue.every("backlog-audit-tick", intervalMs);
  return async () => {
    await queue.close(true);
  };
}
