import type { Database } from "bun:sqlite";

/**
 * Open-PR divergence reconciler (Epic #168). When one Epic PR merges to `main`,
 * other open Epic PRs may become non-mergeable until rebased; this module
 * detects that drift and applies the resolution chain — rebase first, then
 * `-X ours` merge fallback (CLAUDE.md's *new-work-as-base*), then demote-to-work
 * if both autonomous attempts fail.
 *
 * Helpers are pure functions over an injected gateway so they unit-test without
 * `gh` or the daemon; the trigger sibling (`reconcileOpenPRs`) is what wires
 * them into the poller's tick.
 */

/**
 * Mergeability classification for one PR against the latest `main`.
 *
 *  - `CLEAN` — the PR is fully mergeable (`mergeStateStatus = CLEAN` *and*
 *    `mergeable = MERGEABLE`); no reconciliation needed.
 *  - `BEHIND` — head is behind `main` but conflict-free; rebase should succeed.
 *  - `CONFLICTED` — head conflicts with `main`; rebase will conflict, fall back
 *    to the `-X ours` merge or demote.
 *  - `UNKNOWN` — anything else (`BLOCKED` by a required check, `HAS_HOOKS`,
 *    `UNSTABLE`, a transient `UNKNOWN` from GitHub mid-rollup, or a missing
 *    field). The reconciler skips it this pass; the next tick reclassifies.
 *
 * Values are GitHub-vocabulary spellings (UPPERCASE) so the CHECK in
 * `006_pr_divergence_state.sql` can mirror them as constants without case
 * conversion at the persistence boundary.
 */
export type DivergenceState = "CLEAN" | "BEHIND" | "CONFLICTED" | "UNKNOWN";

/** `state` values that may appear in the `pr_divergence_state` table — wider
 *  than {@link DivergenceState} because the reconciler also writes terminal-ish
 *  outcomes (DEMOTED on escalation, SKIPPED when rate-limited). */
export type PersistedDivergenceState = DivergenceState | "DEMOTED" | "SKIPPED";

/**
 * What `gh pr view --json mergeable,mergeStateStatus` shape we read. Kept
 * structural (no implementation-defined values beyond the strings GitHub emits)
 * so the gateway stub in tests is a plain object literal.
 *
 *  - `mergeable` ∈ { `MERGEABLE`, `CONFLICTING`, `UNKNOWN` }
 *  - `mergeStateStatus` ∈ { `CLEAN`, `BEHIND`, `DIRTY`, `BLOCKED`,
 *    `HAS_HOOKS`, `UNSTABLE`, `UNKNOWN` }
 *
 * Either field may be absent on legacy fixtures — treated as `UNKNOWN`.
 */
export type MergeabilityView = {
  mergeable?: string | null;
  mergeStateStatus?: string | null;
};

/** The narrow GitHub surface the divergence classifier needs — injectable so
 *  unit tests need no `gh`. */
export type DivergenceGateway = {
  /** Read the PR's mergeability fields, or null if the PR doesn't exist. */
  getMergeability(repo: string, prNumber: number): Promise<MergeabilityView | null>;
};

/**
 * Pure classification of a {@link MergeabilityView} into a {@link DivergenceState}.
 * Split from {@link classifyDivergence} so tests can hit every branch without
 * threading a gateway. The precedence (DIRTY → BEHIND → CLEAN+MERGEABLE → UNKNOWN)
 * mirrors the order in #169's acceptance criteria.
 */
export function classifyMergeability(view: MergeabilityView | null): DivergenceState {
  if (!view) return "UNKNOWN";
  const status = view.mergeStateStatus ?? null;
  const mergeable = view.mergeable ?? null;
  if (status === "DIRTY") return "CONFLICTED";
  if (status === "BEHIND") return "BEHIND";
  if (status === "CLEAN" && mergeable === "MERGEABLE") return "CLEAN";
  return "UNKNOWN";
}

/**
 * Classify a PR's mergeability against the latest `main` and record the
 * observation in `pr_divergence_state`. The recorded state is exactly the
 * returned {@link DivergenceState} — the reconciler's terminal-ish outcomes
 * (DEMOTED/SKIPPED) are written by the success/demote paths (Phase 4 / 5 / 6),
 * not by the classifier.
 *
 * One `gh` call per PR (`mergeable,mergeStateStatus` on `pr view`), so a sweep
 * over `N` open PRs costs `N` REST calls — the rate-limit ceiling
 * (Phase 6) is what bounds bursts.
 */
export async function classifyDivergence(
  deps: { db: Database; github: DivergenceGateway; now?: () => number },
  repo: string,
  prNumber: number,
): Promise<DivergenceState> {
  const view = await deps.github.getMergeability(repo, prNumber);
  const state = classifyMergeability(view);
  recordDivergenceState(deps.db, repo, prNumber, state, (deps.now ?? Date.now)());
  return state;
}

/** Upsert one row in `pr_divergence_state`. Exposed so the success/demote/skip
 *  paths can write their own terminal-ish states without re-reading GitHub. */
export function recordDivergenceState(
  db: Database,
  repo: string,
  prNumber: number,
  state: PersistedDivergenceState,
  now: number = Date.now(),
): void {
  db.run(
    `INSERT INTO pr_divergence_state (repo, pr_number, state, classified_at)
       VALUES (?, ?, ?, ?)
     ON CONFLICT(repo, pr_number) DO UPDATE SET
       state = excluded.state, classified_at = excluded.classified_at`,
    [repo, prNumber, state, now],
  );
}

/** Read the current row, or null if the PR has never been classified. */
export function getDivergenceState(
  db: Database,
  repo: string,
  prNumber: number,
): { state: PersistedDivergenceState; classifiedAt: number } | null {
  const row = db
    .query("SELECT state, classified_at FROM pr_divergence_state WHERE repo = ? AND pr_number = ?")
    .get(repo, prNumber) as { state: string; classified_at: number } | null;
  if (!row) return null;
  return { state: row.state as PersistedDivergenceState, classifiedAt: row.classified_at };
}
