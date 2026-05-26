/**
 * Checkbox-revert production trigger (#101).
 *
 * The piece that fires the Phase 4 reconciler (`reconcileCheckboxes`) on a real
 * agent push. The reconciler + the Phase 6 gate machinery (`makeRunPhaseGates`)
 * were both fully built and unit-tested, but nothing in production invoked them —
 * this pass closes that gap.
 *
 * It runs on the GitHub poller cron (see `poller-cron.ts`), once per tick, over
 * every **running** implementation workflow: for each, it reads the Epic PR, and
 * when the PR's head SHA has advanced since the last tick (the agent pushed), it
 * runs the declared verification gates for each `[ ] → [x]` Status-checkbox
 * transition and reverts a box whose gates fail. The per-workflow diff base
 * (`{ headSha, checkboxState }`) is persisted in the workflow row's `meta_json`.
 *
 * Why a poller pass and not a Stop hook: the reconciler is GitHub-state-driven
 * (it reads and writes the PR body), which is the poller's domain — this mirrors
 * `reconcileMergedParks`. The hook server deliberately runs no business logic
 * (see this package's CLAUDE.md). It lives in its own module rather than in
 * `poller.ts` so that file's "never writes to GitHub" invariant stays true — this
 * pass *does* write (it reverts the body and comments).
 */
import type { Database } from "bun:sqlite";
import type { GitHubGateway } from "../github.ts";
import type { RateLimitStatus } from "../poller.ts";
import {
  getCheckboxReconcileState,
  listRunningImplementationWorkflows,
  setCheckboxReconcileState,
} from "../workflow-record.ts";
import { reconcileCheckboxes } from "./checkbox-revert.ts";
import { makeRunPhaseGates } from "./verify.ts";
import { loadVerifyConfig, type VerifyConfig, verifyConfigPath } from "./verify-config.ts";

/**
 * Default `verify.toml` loader: read the worktree's config, returning null when
 * it's missing/malformed. A workflow with no usable config has no gates to
 * enforce, so a ticked box can never fail one — the pass skips it (mirrors
 * verify-on-stop's skip-on-missing-config in `build-deps.ts`).
 */
function defaultLoadConfig(worktreePath: string): VerifyConfig | null {
  try {
    return loadVerifyConfig(verifyConfigPath(worktreePath));
  } catch {
    return null;
  }
}

/**
 * Everything {@link runCheckboxRevertPass} needs to service one pass: the workflow
 * `db` it scans for running rows, the write-capable GitHub `github` gateway it
 * reverts through, and the `getRateLimit` budget read it gates the pass on. The
 * remaining fields are test/tuning seams with production defaults — `loadConfig`
 * (per-worktree `verify.toml` loader), `now`, `rateLimitBuffer`, and
 * `maxPollsPerPass` — so production wires only the first three.
 */
export type CheckboxRevertPassDeps = {
  db: Database;
  /** Write-capable GitHub access: find the Epic PR, edit its body, comment, post evidence. */
  github: GitHubGateway;
  /**
   * GitHub's remaining REST budget — the free `rate_limit` read (wired from the
   * poll gateway in prod). The pass is skipped when the budget is below the buffer.
   */
  getRateLimit: () => Promise<RateLimitStatus>;
  /** Override the per-worktree config loader (tests inject a parsed config). */
  loadConfig?: (worktreePath: string) => VerifyConfig | null;
  now?: () => number;
  /** Skip the pass when GitHub's remaining budget is below this. */
  rateLimitBuffer?: number;
  /** Cap on workflows serviced in one pass (burst protection). */
  maxPollsPerPass?: number;
};

/** Mirrors the poller's defaults so all GitHub-cron passes share one budget posture. */
const DEFAULT_RATE_LIMIT_BUFFER = 100;
const DEFAULT_MAX_POLLS_PER_PASS = 25;

/**
 * One checkbox-revert pass over every running implementation workflow. Returns the
 * number of checkboxes reverted across the pass (for logging/tests).
 *
 * Shares the poller's GitHub-friendliness guards — the free rate-limit ceiling and
 * the per-pass burst cap — and isolates per-workflow failures (a GitHub hiccup or a
 * thrown gate skips that workflow this pass and is retried next tick; it never
 * aborts the pass for the others).
 */
export async function runCheckboxRevertPass(deps: CheckboxRevertPassDeps): Promise<number> {
  const buffer = deps.rateLimitBuffer ?? DEFAULT_RATE_LIMIT_BUFFER;
  const maxPerPass = deps.maxPollsPerPass ?? DEFAULT_MAX_POLLS_PER_PASS;
  const loadConfig = deps.loadConfig ?? defaultLoadConfig;

  const running = listRunningImplementationWorkflows(deps.db);
  if (running.length === 0) return 0;

  // Rate-limit ceiling: never let this pass be the call that tips the account over.
  const budget = await deps.getRateLimit();
  if (budget.remaining < buffer) {
    console.error(
      `[checkbox-revert] GitHub budget low (${budget.remaining} < ${buffer}); skipping pass — resets ${new Date(budget.resetAt).toISOString()}`,
    );
    return 0;
  }

  let reverted = 0;
  for (const wf of running.slice(0, maxPerPass)) {
    try {
      const config = loadConfig(wf.worktreePath);
      if (!config) continue; // no gates to enforce → nothing to revert

      const pr = await deps.github.findEpicPr(wf.repo, wf.epicNumber);
      if (!pr) continue; // PR not opened yet

      const previous = getCheckboxReconcileState(deps.db, wf.id);
      // Head-SHA gate: skip the parse/diff/gate-run when the PR hasn't advanced
      // since the last tick. A gateway that can't supply a SHA (undefined) falls
      // through — the reconciler's own checkbox-state diff still gates the work.
      if (pr.headSha !== undefined && pr.headSha === previous.headSha) continue;

      const runGates = makeRunPhaseGates({
        repo: wf.repo,
        prNumber: pr.number,
        worktreePath: wf.worktreePath,
        config,
        github: deps.github,
      });

      // The PR body is already fetched in `pr`; thread the local copy through so
      // the reconciler reads the latest after a revert without a re-fetch.
      let body = pr.body;
      const result = await reconcileCheckboxes({
        getPrBody: async () => body,
        setPrBody: async (next) => {
          body = next;
          await deps.github.editPullRequestBody(wf.repo, pr.number, next);
        },
        postComment: async (text) => {
          await deps.github.postComment(wf.repo, pr.number, text);
        },
        runGates,
        getPreviousState: async () => previous.state,
        // Persist the new diff base (post-revert checkbox state + the SHA we just
        // serviced) so the next tick neither re-runs this push's gates nor
        // re-treats a reverted box as a transition.
        setPreviousState: async (state) => {
          setCheckboxReconcileState(deps.db, wf.id, { headSha: pr.headSha ?? null, state });
        },
      });
      reverted += result.reverted.length;
    } catch (error) {
      console.error(
        `[checkbox-revert] pass failed for workflow ${wf.id} (${wf.repo}#${wf.epicNumber}): ${(error as Error).message}`,
      );
    }
  }
  return reverted;
}
