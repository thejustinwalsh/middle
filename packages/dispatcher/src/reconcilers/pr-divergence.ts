import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createWorktree, type WorktreeHandle } from "../worktree.ts";

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

// ── Phase 2: rebase helper ──────────────────────────────────────────────────

/** Outcome of a rebase or merge attempt. Conflict surfaces the file paths so
 *  the demote-to-work path can name them in its escalation comment. */
export type GitResolutionResult = { ok: true } | { ok: false; conflictingPaths: string[] };

/** Convention from the rest of the daemon (`createWorktree`): the dispatch
 *  unit for an Epic with number N is the branch `middle-issue-N`. */
const HEAD_REF_PREFIX = "middle-issue-";

/** Parse the Epic number out of a managed PR's head ref, or null if the ref
 *  doesn't follow the `middle-issue-<N>` convention (e.g. a non-managed PR). */
export function parseEpicFromHeadRef(headRefName: string): number | null {
  if (!headRefName.startsWith(HEAD_REF_PREFIX)) return null;
  const tail = headRefName.slice(HEAD_REF_PREFIX.length);
  const n = Number(tail);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The narrow GitHub surface the rebase/merge helpers need on top of
 *  {@link DivergenceGateway} — the PR's head ref so we can find its worktree. */
export type PrHeadRefGateway = {
  /** Read the PR's head-ref name (e.g. `middle-issue-32`), or null if the PR
   *  doesn't exist. */
  getPrHeadRef(repo: string, prNumber: number): Promise<string | null>;
};

/**
 * Pure-`git` operations the rebase/merge helpers run inside a worktree.
 * Injectable so unit tests don't shell out, but the production implementation
 * (`gitOps`) is what the integration test exercises against a real fixture repo.
 */
export type GitOps = {
  /** `git fetch origin <ref>` in `cwd`. Throws on a real fetch failure (network,
   *  no remote); the helper catches and reports it as an UNKNOWN-shaped result. */
  fetch(cwd: string, ref: string): Promise<void>;
  /** `git rebase <upstream>`. Returns `{ ok: true }` on a clean rebase (incl. FF)
   *  and `{ ok: false, conflictingPaths }` after aborting on conflict. */
  rebase(cwd: string, upstream: string): Promise<GitResolutionResult>;
};

async function spawnGit(
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

/**
 * The conflicting paths from a worktree mid-rebase, read via
 * `git diff --name-only --diff-filter=U` (unmerged-only). Empty when no
 * conflict markers exist — the rebase's own non-zero exit then has a different
 * cause (a missing upstream, a hook refusal) which the helper surfaces as the
 * empty-paths variant of the conflict result, never as a thrown error.
 */
async function readConflictingPaths(cwd: string): Promise<string[]> {
  const r = await spawnGit(cwd, ["diff", "--name-only", "--diff-filter=U"]);
  if (r.exitCode !== 0) return [];
  return r.stdout.split("\n").filter((l) => l.trim() !== "");
}

/** The production {@link GitOps}: real `git` via `Bun.spawn`. */
export const gitOps: GitOps = {
  async fetch(cwd: string, ref: string): Promise<void> {
    const r = await spawnGit(cwd, ["fetch", "origin", ref]);
    if (r.exitCode !== 0) {
      throw new Error(`git fetch origin ${ref} failed: ${r.stderr.trim()}`);
    }
  },
  async rebase(cwd: string, upstream: string): Promise<GitResolutionResult> {
    const r = await spawnGit(cwd, ["rebase", upstream]);
    if (r.exitCode === 0) return { ok: true };
    // Conflict path: capture paths BEFORE abort (abort clears the unmerged
    // index, after which `--diff-filter=U` returns nothing).
    const conflictingPaths = await readConflictingPaths(cwd);
    await spawnGit(cwd, ["rebase", "--abort"]);
    return { ok: false, conflictingPaths };
  },
};

/** Default root for `git worktree` dispatch units — must match `createWorktree`. */
function defaultWorktreeRoot(): string {
  return join(homedir(), ".middle", "worktrees");
}

/** Where a worktree for `<repo>` and Epic `<epicNumber>` should live, matching the
 *  layout `createWorktree` uses. */
export function worktreePathFor(repo: string, epicNumber: number, worktreeRoot?: string): string {
  return join(worktreeRoot ?? defaultWorktreeRoot(), repo, `issue-${epicNumber}`);
}

/** Deps shared by the git helpers that operate on a managed PR's worktree —
 *  the rebase helper here, and the merge-commit fallback / success / demote
 *  helpers in later phases. Worktree resolution / re-creation is centralized
 *  here so each helper doesn't duplicate the path math + create fallback. */
export type WorktreeOpsDeps = {
  github: PrHeadRefGateway;
  git: GitOps;
  /** Local checkout path for a repo slug — needed to recreate a missing worktree. */
  resolveRepoPath: (repo: string) => string;
  /** Worktree root override; defaults to `~/.middle/worktrees`. */
  worktreeRoot?: string;
  /** Worktree creation seam — defaults to `createWorktree`; injectable for tests. */
  createWorktree?: (opts: {
    repoPath: string;
    repo: string;
    issueNumber: number;
    worktreeRoot?: string;
  }) => Promise<WorktreeHandle>;
};

/**
 * Resolve a PR's worktree path: existing under the worktree root, otherwise
 * recreate it via `createWorktree`. Returns `null` when the PR has no managed
 * head ref (not a `middle-issue-<N>` branch) — the caller short-circuits and
 * leaves the PR alone. Throws only when the head ref looks managed but the
 * recreate path fails (a real wiring/disk error worth surfacing).
 */
export async function resolveWorktreePath(
  deps: WorktreeOpsDeps,
  repo: string,
  prNumber: number,
): Promise<{ worktreePath: string; epicNumber: number } | null> {
  const headRef = await deps.github.getPrHeadRef(repo, prNumber);
  if (!headRef) return null;
  const epicNumber = parseEpicFromHeadRef(headRef);
  if (epicNumber === null) return null;
  const worktreePath = worktreePathFor(repo, epicNumber, deps.worktreeRoot);
  if (existsSync(worktreePath)) return { worktreePath, epicNumber };
  const create = deps.createWorktree ?? createWorktree;
  await create({
    repoPath: deps.resolveRepoPath(repo),
    repo,
    issueNumber: epicNumber,
    worktreeRoot: deps.worktreeRoot,
  });
  return { worktreePath, epicNumber };
}

/**
 * Attempt to rebase the PR's worktree onto the latest `origin/main`. The
 * function is the composition of:
 *
 *  1. resolve the worktree (existing under the root, else recreate),
 *  2. `git fetch origin main`,
 *  3. `git rebase origin/main`,
 *  4. on conflict → `git rebase --abort` and report the unmerged paths.
 *
 * It does NOT push (Phase 4 owns the push) and does NOT fall back to a merge
 * commit (Phase 3 / the trigger sibling do). On a head ref that isn't a managed
 * `middle-issue-<N>` branch, the function reports `ok: false` with empty
 * `conflictingPaths` so the caller skips this PR — distinguishable from an
 * actual conflict because no paths are surfaced.
 */
export async function tryRebaseOntoMain(
  deps: WorktreeOpsDeps,
  repo: string,
  prNumber: number,
): Promise<GitResolutionResult> {
  const resolved = await resolveWorktreePath(deps, repo, prNumber);
  if (!resolved) return { ok: false, conflictingPaths: [] };
  await deps.git.fetch(resolved.worktreePath, "main");
  return deps.git.rebase(resolved.worktreePath, "origin/main");
}
