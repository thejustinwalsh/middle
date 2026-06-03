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
 *
 * A `getMergeability` transport/auth failure propagates as a thrown error (the
 * gateway distinguishes that from a missing PR — see `ghStderrIsNotFound`). The
 * orchestrator's per-PR try/catch counts that as `failed`, and the state row
 * stays at its previous observation rather than being overwritten with a stale
 * UNKNOWN — preserving the failure signal for the operator.
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
  /** `git merge -X ours <ref>` — *new-work-as-base* on a content collision: the
   *  branch's version wins, so main's net-new edits land on top. On a residual
   *  conflict `-X ours` can't auto-resolve (rare; rename/rename, modify/delete),
   *  aborts with `git merge --abort` and reports the unmerged paths. */
  mergeOurs(cwd: string, ref: string): Promise<GitResolutionResult>;
  /** `git rev-parse <ref>` — the SHA the ref points at, or null if it doesn't
   *  resolve (e.g. no remote-tracking ref yet). */
  revParse(cwd: string, ref: string): Promise<string | null>;
  /** `git push --force-with-lease origin <branch>` — agent-managed branches only.
   *  Throws on push failure (a real conflict caught by the lease, or a permission
   *  / network error); `applySuccess` propagates so the trigger sibling retries
   *  next pass instead of silently advancing state. */
  pushForceWithLease(cwd: string, branch: string): Promise<void>;
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
 * The conflicting paths from a worktree mid-rebase/merge, read via
 * `git diff --name-only --diff-filter=U` (unmerged-only). Returns the list of
 * paths git considers unmerged right now — empty when none.
 *
 * The helpers below distinguish "non-zero exit AND no unmerged paths" (a real
 * wiring failure: missing upstream, hook refusal, dirty worktree) from "non-
 * zero exit AND ≥1 unmerged path" (a genuine merge conflict). The first throws;
 * the second returns the paths so the caller can fall back / demote.
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
    if (conflictingPaths.length === 0) {
      // Non-zero exit AND no unmerged files = wiring failure (missing
      // upstream, hook refusal, dirty worktree). Surface the underlying error
      // so the orchestrator's per-PR try/catch logs it and the pass continues;
      // do NOT shape it as `{ok:false, conflictingPaths:[]}`, which the
      // applyDemoteToWork path would read as a real (path-less) conflict.
      throw new Error(`git rebase ${upstream} failed without unmerged files: ${r.stderr.trim()}`);
    }
    return { ok: false, conflictingPaths };
  },
  async mergeOurs(cwd: string, ref: string): Promise<GitResolutionResult> {
    // `--no-edit` keeps the run non-interactive when -X ours auto-resolves and a
    // merge commit is produced. `--no-ff` ensures even a fast-forward-eligible
    // merge produces a commit (the reconciliation is loud on purpose so a
    // reviewer can see main was folded in).
    const r = await spawnGit(cwd, ["merge", "--no-edit", "--no-ff", "-X", "ours", ref]);
    if (r.exitCode === 0) return { ok: true };
    const conflictingPaths = await readConflictingPaths(cwd);
    await spawnGit(cwd, ["merge", "--abort"]);
    if (conflictingPaths.length === 0) {
      // Same distinction as `rebase` above — surface a real failure rather than
      // a path-less conflict shape.
      throw new Error(`git merge ${ref} failed without unmerged files: ${r.stderr.trim()}`);
    }
    return { ok: false, conflictingPaths };
  },
  async revParse(cwd: string, ref: string): Promise<string | null> {
    // `--verify` keeps `rev-parse` from emitting a "fail-silent" fallback string
    // for an unknown ref; we want null, not "<ref-string>".
    const r = await spawnGit(cwd, ["rev-parse", "--verify", "--quiet", ref]);
    if (r.exitCode !== 0) return null;
    const sha = r.stdout.trim();
    return sha === "" ? null : sha;
  },
  async pushForceWithLease(cwd: string, branch: string): Promise<void> {
    const r = await spawnGit(cwd, ["push", "--force-with-lease", "origin", branch]);
    if (r.exitCode !== 0) {
      throw new Error(`git push --force-with-lease origin ${branch} failed: ${r.stderr.trim()}`);
    }
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
    epicRef: string;
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
    epicRef: String(epicNumber),
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

/**
 * Merge-commit fallback when `tryRebaseOntoMain` keeps re-conflicting on the
 * same hunks (CLAUDE.md → "Keeping the branch mergeable into main" → escape
 * hatch). Performs a single `git merge -X ours origin/main` resolved
 * **new-work-as-base**: on content collisions the branch's version wins, so
 * main's net-new edits land cleanly on top.
 *
 *  - `{ ok: true }` — the merge landed (clean or `-X ours`-resolved).
 *  - `{ ok: false, conflictingPaths }` — a residual conflict `-X ours` can't
 *    auto-resolve (structural: rename/rename, modify/delete, dir/file). The
 *    merge is aborted with `git merge --abort` so the worktree is clean.
 *
 * Mirrors `tryRebaseOntoMain`'s skip behavior for a non-managed head ref (the
 * empty-paths case the trigger sibling distinguishes).
 */
export async function tryMergeMainNewWorkAsBase(
  deps: WorktreeOpsDeps,
  repo: string,
  prNumber: number,
): Promise<GitResolutionResult> {
  const resolved = await resolveWorktreePath(deps, repo, prNumber);
  if (!resolved) return { ok: false, conflictingPaths: [] };
  await deps.git.fetch(resolved.worktreePath, "main");
  return deps.git.mergeOurs(resolved.worktreePath, "origin/main");
}

// ── Phase 4: applySuccess ───────────────────────────────────────────────────

/** Resolution kind passed to {@link applySuccess}; mirrored verbatim in the PR
 *  comment so reviewers can see which path landed the reconciliation. */
export type ReconciliationResolution = "rebased" | "merged-new-work-as-base";

/** The narrow comment surface `applySuccess` needs — listing for idempotency,
 *  posting for the one announcement. Matches the existing
 *  {@link "../github.ts".EpicGateway} method names so the daemon-side
 *  composition is a thin `Pick`. */
export type PrCommentGateway = {
  listIssueComments(repo: string, ref: string): Promise<{ body: string }[]>;
  postComment(repo: string, ref: string, body: string): Promise<void>;
};

/** Deps for `applySuccess` — the union of worktree resolution (head ref +
 *  git) and PR-comment ops, plus the SQLite handle for the state update. */
export type ApplySuccessDeps = WorktreeOpsDeps & {
  db: Database;
  github: PrHeadRefGateway & PrCommentGateway;
  now?: () => number;
};

/** Render the hidden HTML marker that makes comment-posting idempotent across
 *  consecutive `applySuccess` calls for the *same* reconciliation
 *  (resolution + main sha). A future main sha re-allows a fresh announcement. */
function reconciledMarker(resolution: ReconciliationResolution, mainCommitSha: string): string {
  return `<!-- middle-divergence: ${mainCommitSha.slice(0, 9)}:${resolution} -->`;
}

/**
 * Apply the success path of a reconciliation: push the rebased / merged
 * worktree back to its PR branch, post a single announcement on the PR, and
 * record `CLEAN` in `pr_divergence_state`. Idempotent across consecutive
 * invocations for the same reconciliation:
 *
 *  - **Push:** `git fetch origin <branch>` first, then push only if the local
 *    HEAD differs from `origin/<branch>` — so a re-call when the branch is
 *    already at the target state is a no-op (per #172's spec).
 *  - **Comment:** scans existing comments for the resolution+sha marker; posts
 *    only if absent. The marker is hidden HTML in the body, so the visible
 *    text stays clean. When `mainCommitSha` is null (a transient
 *    `getMainCommitSha` failure during the same pass), the comment step is
 *    **skipped** — the marker would be ambiguous — but the push + state-row
 *    write still happen. A later reconciliation pass announces against
 *    *whatever main it reads then* (which may be a newer SHA than the one
 *    this pass would have used); the sha-keyed marker prevents a duplicate
 *    when the SHA matches and allows a fresh announcement when main moved.
 *  - **State row:** upserted to `CLEAN` — idempotent by construction.
 *
 * Force-pushing uses `--force-with-lease` (never plain `--force`), so a
 * concurrent push from a human collaborator surfaces as a push failure rather
 * than silently overwriting their work.
 *
 * A non-managed head ref (the PR isn't `middle-issue-<N>`) short-circuits as a
 * no-op — `applySuccess` is never the right action for a non-managed PR.
 */
export async function applySuccess(
  deps: ApplySuccessDeps,
  repo: string,
  prNumber: number,
  resolution: ReconciliationResolution,
  mainCommitSha: string | null,
): Promise<void> {
  const resolved = await resolveWorktreePath(deps, repo, prNumber);
  if (!resolved) return;
  const branch = `${HEAD_REF_PREFIX}${resolved.epicNumber}`;

  // Sync the remote-tracking ref so the local-vs-remote comparison reflects
  // the live origin state, not whatever was last cached.
  await deps.git.fetch(resolved.worktreePath, branch);
  const localSha = await deps.git.revParse(resolved.worktreePath, "HEAD");
  const remoteSha = await deps.git.revParse(resolved.worktreePath, `refs/remotes/origin/${branch}`);
  if (localSha !== null && localSha !== remoteSha) {
    await deps.git.pushForceWithLease(resolved.worktreePath, branch);
  }

  // Comment only when we have a main SHA to key the marker by; the next pass
  // re-posts under the right SHA. Push + state-row write are unconditional —
  // the rebase/merge already landed locally, so failing to comment shouldn't
  // also fail to record the success.
  if (mainCommitSha !== null) {
    const marker = reconciledMarker(resolution, mainCommitSha);
    const existing = await deps.github.listIssueComments(repo, String(prNumber));
    const alreadyPosted = existing.some((c) => (c.body ?? "").includes(marker));
    if (!alreadyPosted) {
      const body = `🔁 Reconciled with main (${resolution}) after ${mainCommitSha.slice(0, 9)}\n\n${marker}`;
      await deps.github.postComment(repo, String(prNumber), body);
    }
  }

  recordDivergenceState(deps.db, repo, prNumber, "CLEAN", (deps.now ?? Date.now)());
}

// ── Phase 5: applyDemoteToWork ──────────────────────────────────────────────

/** One closed sub-issue under an Epic, as
 *  {@link ApplyDemoteGateway.listClosedSubIssues} returns them. `closedAt` is
 *  epoch ms or null if GitHub doesn't surface it (a hand-edited row). */
export type ClosedSubIssue = { number: number; closedAt: number | null };

/** The narrow gateway `applyDemoteToWork` needs on top of comment posting:
 *  the PR's draft state, the draft-conversion mutation, the sub-issue listing,
 *  and the reopen call. Production wiring lives in Phase 6. */
export type ApplyDemoteGateway = PrHeadRefGateway &
  PrCommentGateway & {
    /** Read the PR's draft status, or null if the PR doesn't exist. */
    getPullRequest(repo: string, prNumber: number): Promise<{ isDraft: boolean } | null>;
    /** Convert a PR back to a draft. Caller already checked `isDraft = false`. */
    convertPrToDraft(repo: string, prNumber: number): Promise<void>;
    /** Closed sub-issues of an Epic, most-recently-closed first
     *  (caller relies on the ordering — don't return unsorted). */
    listClosedSubIssues(repo: string, epicNumber: number): Promise<ClosedSubIssue[]>;
    /** Reopen an issue and optionally post a comment in the same call. Idempotent
     *  on GitHub's side: reopening an already-open issue is a no-op. */
    reopenIssue(repo: string, issueNumber: number, options?: { comment?: string }): Promise<void>;
  };

/** Deps for `applyDemoteToWork` — gateway + db + the re-enqueue seam (caller
 *  wires it through the recommender entry point so ranking still applies). */
export type ApplyDemoteDeps = {
  db: Database;
  github: ApplyDemoteGateway;
  /** Re-enqueue the Epic for dispatch. Daemon-wired to a recommender run +
   *  `scheduleAutoDispatch(repo)` so the recommender's ranking still applies.
   *  The wiring is idempotent — the existing collision guard on the
   *  enqueue path no-ops a duplicate dispatch for the same Epic. */
  enqueueEpic: (repo: string, epicNumber: number) => Promise<void>;
  now?: () => number;
};

/** Hidden HTML marker that gates the dual-surface escalation comment per Epic.
 *  A retry after a partial failure (PR was demoted but a follow-on call lost
 *  the comment-post step) sees the marker and skips the duplicate. */
function demoteMarker(epicNumber: number): string {
  return `<!-- middle-divergence-demoted: ${epicNumber} -->`;
}

function renderDemoteEscalation(
  epicNumber: number,
  prNumber: number,
  conflictingPaths: string[],
): string {
  const pathsLine =
    conflictingPaths.length > 0
      ? conflictingPaths.map((p) => `- \`${p}\``).join("\n")
      : "_(no conflicting paths reported — the rebase and merge fallback both failed without surfacing unmerged files; investigate manually)_";
  return [
    `🛑 **Reconciliation escalation:** PR #${prNumber} for Epic #${epicNumber} could not be auto-reconciled with \`main\`.`,
    ``,
    `Both autonomous attempts failed:`,
    `1. \`git rebase origin/main\` — conflicts`,
    `2. \`git merge -X ours origin/main\` (new-work-as-base) — residual conflict`,
    ``,
    `Conflicting paths:`,
    pathsLine,
    ``,
    `The PR has been flipped back to **draft** and the most-recently-closed sub-issue reopened so a fresh agent can pick up conflict resolution. The Epic has been re-enqueued through the recommender's ranking — it will be dispatched again when slots free up.`,
    ``,
    demoteMarker(epicNumber),
  ].join("\n");
}

function renderSubIssueReopenComment(prNumber: number, epicNumber: number): string {
  return `Reopened by the open-PR reconciler: PR #${prNumber} for Epic #${epicNumber} could not be auto-reconciled with \`main\`. See the escalation comment on the Epic and the PR for details.`;
}

/**
 * Demote a PR back to work when both autonomous reconciliation attempts (rebase
 * + `-X ours` merge) have failed. Flips the PR to draft, reopens the most-
 * recently-closed sub-issue of the Epic with an escalation comment, posts the
 * same escalation on both the Epic and the PR (dual-surface per CLAUDE.md's
 * review-feedback convention), re-enqueues the Epic through the recommender's
 * entry point, and records `DEMOTED` in `pr_divergence_state`.
 *
 * Idempotency is **per-step**, never a function-wide short-circuit — a partial
 * prior attempt (e.g. the PR got flipped to draft but the next call crashed
 * before reopen/comment/enqueue/state-write) must still be able to finish
 * remediation on retry. Each step has its own gate so duplicates don't pile on:
 *  - **PR.isDraft** — if the PR is already a draft, skip the `convertPrToDraft`
 *    step; the rest of the function still runs so a partial prior attempt can
 *    complete. This also survives a classifier overwrite of the state row back
 *    to CONFLICTED (a re-classification under DEMOTED).
 *  - **Epic-keyed marker on prior demote** — if the Epic already carries the
 *    demote marker from a previous incident, skip the sub-issue reopen even if
 *    the PR was un-drafted in the meantime (e.g. a human reviewed the
 *    escalation, manually fixed the conflict, marked the PR ready, and a fresh
 *    divergence emerged). Without this gate the reconciler would re-fire
 *    `reopenIssue` against a sub-issue the human had already closed.
 *  - **comment marker** — the dual-surface comments include a hidden HTML
 *    marker keyed on the Epic number; on a retry that comes after the post
 *    succeeded but before the row was written, the listing-then-post sequence
 *    sees the marker and skips.
 *
 * `enqueueEpic` is itself idempotent (the daemon-wired implementation collides
 * against the existing-workflow guard) so a re-enqueue on the same Epic is
 * safe; we still call it on each demote pass so the recommender's ranking gets
 * a fresh nudge after the new divergence.
 *
 * Non-managed head refs (the PR isn't `middle-issue-<N>`) short-circuit as a
 * no-op — the reconciler is never the right hand for those.
 */
export async function applyDemoteToWork(
  deps: ApplyDemoteDeps,
  repo: string,
  prNumber: number,
  conflictingPaths: string[],
): Promise<void> {
  const headRef = await deps.github.getPrHeadRef(repo, prNumber);
  if (!headRef) return;
  const epicNumber = parseEpicFromHeadRef(headRef);
  if (epicNumber === null) return;

  const pr = await deps.github.getPullRequest(repo, prNumber);
  if (!pr) return;

  // Skip only the draft-flip step on a partial-retry, not the rest of
  // remediation — a prior attempt that crashed AFTER converting to draft but
  // BEFORE the reopen/comment/enqueue/state-write must still be able to finish
  // those steps on the next pass. Duplicates downstream are gated per-step
  // (Epic marker, comment marker, enqueueEpic's own existing-workflow guard).
  if (!pr.isDraft) {
    await deps.github.convertPrToDraft(repo, prNumber);
  }

  const marker = demoteMarker(epicNumber);
  const epicComments = await deps.github.listIssueComments(repo, String(epicNumber));
  const epicAlreadyDemoted = epicComments.some((c) => (c.body ?? "").includes(marker));

  // Most-recently-closed sub-issue, if any. Skip the reopen when the Epic
  // already carries a prior demote marker — a human may have manually fixed
  // the conflict and closed that sub-issue; we don't fight their recovery.
  // The fresh divergence still demotes the PR + posts the new escalation +
  // re-enqueues; only the reopen is suppressed.
  if (!epicAlreadyDemoted) {
    const closedSubs = await deps.github.listClosedSubIssues(repo, epicNumber);
    const targetSub = closedSubs[0]; // gateway contract: most-recently-closed first
    if (targetSub) {
      await deps.github.reopenIssue(repo, targetSub.number, {
        comment: renderSubIssueReopenComment(prNumber, epicNumber),
      });
    }
  }

  // Dual-surface escalation. Same marker on both surfaces gates re-posts.
  const escalationBody = renderDemoteEscalation(epicNumber, prNumber, conflictingPaths);

  for (const issueNumber of [prNumber, epicNumber]) {
    const existing =
      issueNumber === epicNumber
        ? epicComments
        : await deps.github.listIssueComments(repo, String(issueNumber));
    if (!existing.some((c) => (c.body ?? "").includes(marker))) {
      await deps.github.postComment(repo, String(issueNumber), escalationBody);
    }
  }

  await deps.enqueueEpic(repo, epicNumber);

  recordDivergenceState(deps.db, repo, prNumber, "DEMOTED", (deps.now ?? Date.now)());
}

// ── Phase 6: reconcileOpenPRs + production gateway ─────────────────────────

/** Header info for a managed open PR — drives the per-PR reconciliation chain. */
export type OpenManagedPr = {
  prNumber: number;
  /** Always starts with `middle-issue-`; the reconciler's listing filter enforces it. */
  headRefName: string;
};

/** The narrow GitHub surface the orchestrator needs on top of the per-phase
 *  gateways: listing the managed PRs to walk + reading the current main HEAD
 *  SHA (used by `applySuccess` so the comment names the main the reconciliation
 *  caught up to). */
export type OrchestratorGateway = {
  /** Open PRs whose head ref is a managed `middle-issue-<N>` branch.
   *  Implementations list and filter — the gh PR search syntax can't strictly
   *  pin a prefix. Capped at 100 by `gh pr list --limit 100`; a backlog past
   *  that is the rate-limit floor's problem, not the orchestrator's. */
  listOpenManagedPrs(repo: string): Promise<OpenManagedPr[]>;
  /** The current SHA of `main` on origin — embedded in `applySuccess`'s
   *  comment marker so a future reconciliation against a newer main re-announces. */
  getMainCommitSha(repo: string): Promise<string | null>;
};

/** Composite gateway the orchestrator needs end-to-end. */
export type ReconcilerGateway = OrchestratorGateway & DivergenceGateway & ApplyDemoteGateway;

/** GitHub's REST budget status — mirrors {@link "../poller.ts".RateLimitStatus}.
 *  Re-stated here so the reconciler doesn't import from `poller.ts` for one type. */
export type RestBudget = { remaining: number; resetAt: number };

/** Skip the pass when GitHub's remaining REST budget is below this. Matches
 *  the resume poller's default ({@link "../poller.ts".DEFAULT_RATE_LIMIT_BUFFER})
 *  so the two reconcilers exercise the same restraint. */
export const DEFAULT_RECONCILER_BUDGET_FLOOR = 100;

/** Cap on PRs reconciled in one pass — bounds the burst when many PRs accumulate. */
export const DEFAULT_MAX_PRS_PER_PASS = 25;

/** Deps the orchestrator pulls together — the per-phase deps + gateway +
 *  rate-limit read + the recommender enqueue seam. Daemon-wired in Phase 6. */
export type ReconcileOpenPRsDeps = WorktreeOpsDeps & {
  db: Database;
  github: ReconcilerGateway;
  /** Re-enqueue the Epic for dispatch (drives `applyDemoteToWork`). */
  enqueueEpic: (repo: string, epicNumber: number) => Promise<void>;
  /** GitHub REST budget — checking it costs no budget. */
  getRateLimit: () => Promise<RestBudget>;
  /** Skip the pass when `getRateLimit().remaining < rateLimitBuffer`. */
  rateLimitBuffer?: number;
  /** Cap on PRs reconciled per pass. */
  maxPrsPerPass?: number;
  now?: () => number;
};

/** Counters returned from one `reconcileOpenPRs` pass. */
export type ReconcileOpenPRsResult = {
  /** PRs that the chain advanced (rebased / merged / demoted), summed. */
  reconciled: number;
  /** PRs walked but left as-is (CLEAN or UNKNOWN — nothing to do this pass). */
  passed: number;
  /** PRs whose chain threw before completing — observability for transient
   *  GitHub / git failures the orchestrator's per-PR try/catch logged and
   *  isolated. Counted alongside `reconciled`/`passed` so a pass of all-failures
   *  is distinguishable from a pass of all-CLEAN. */
  failed: number;
  /** True when the whole pass was short-circuited by the rate-limit floor. */
  skippedForBudget: boolean;
};

/**
 * Walk one repo's open managed PRs and apply the reconciliation chain:
 *
 *   classifyDivergence → if BEHIND/CONFLICTED →
 *     tryRebaseOntoMain → ok → applySuccess('rebased')
 *                       → conflict →
 *       tryMergeMainNewWorkAsBase → ok → applySuccess('merged-new-work-as-base')
 *                                 → conflict → applyDemoteToWork(union of paths)
 *
 * Per-PR failures are isolated and logged; the pass continues. Skipped wholesale
 * when GitHub's REST budget is below `rateLimitBuffer` — the (free) `rate_limit`
 * read is the only call that costs nothing. Per-pass burst is capped at
 * `maxPrsPerPass`; the remainder is picked up next tick.
 *
 * Returns counters for logging/tests. Does not throw — the cron wrapper that
 * calls this never has to guard.
 */
export async function reconcileOpenPRs(
  deps: ReconcileOpenPRsDeps,
  repo: string,
): Promise<ReconcileOpenPRsResult> {
  const buffer = deps.rateLimitBuffer ?? DEFAULT_RECONCILER_BUDGET_FLOOR;
  const maxPerPass = deps.maxPrsPerPass ?? DEFAULT_MAX_PRS_PER_PASS;

  const budget = await deps.getRateLimit();
  if (budget.remaining < buffer) {
    console.error(
      `[pr-divergence] GitHub budget low (${budget.remaining} < ${buffer}); skipping pass — resets ${new Date(budget.resetAt).toISOString()}`,
    );
    return { reconciled: 0, passed: 0, failed: 0, skippedForBudget: true };
  }

  let prs: OpenManagedPr[];
  try {
    prs = await deps.github.listOpenManagedPrs(repo);
  } catch (error) {
    console.error(
      `[pr-divergence] list open managed PRs for ${repo} failed: ${(error as Error).message}`,
    );
    return { reconciled: 0, passed: 0, failed: 0, skippedForBudget: false };
  }
  if (prs.length === 0) {
    return { reconciled: 0, passed: 0, failed: 0, skippedForBudget: false };
  }
  if (prs.length > maxPerPass) {
    console.error(
      `[pr-divergence] ${repo}: ${prs.length} managed PRs > ${maxPerPass} per-pass cap; processing the first ${maxPerPass} (remainder next tick)`,
    );
  }

  // Fetched once per pass so applySuccess's comment marker is consistent across
  // every PR the pass advances. Failures (transient GitHub) leave the marker
  // unset — applySuccess simply skips its comment step in that case (the marker
  // would be ambiguous), but the rebase/merge state already landed.
  let mainSha: string | null = null;
  try {
    mainSha = await deps.github.getMainCommitSha(repo);
  } catch (error) {
    console.error(`[pr-divergence] read main SHA for ${repo} failed: ${(error as Error).message}`);
  }

  let reconciled = 0;
  let passed = 0;
  let failed = 0;

  for (const pr of prs.slice(0, maxPerPass)) {
    try {
      const divergence = await classifyDivergence(deps, repo, pr.prNumber);
      if (divergence === "CLEAN" || divergence === "UNKNOWN") {
        passed++;
        continue;
      }

      // BEHIND or CONFLICTED — try rebase first.
      const rebaseResult = await tryRebaseOntoMain(deps, repo, pr.prNumber);
      if (rebaseResult.ok) {
        // applySuccess pushes + records CLEAN regardless of mainSha; the
        // comment step skips itself when mainSha is null.
        await applySuccess(deps, repo, pr.prNumber, "rebased", mainSha);
        reconciled++;
        continue;
      }

      // Rebase loop — try -X ours merge fallback (new-work-as-base).
      const mergeResult = await tryMergeMainNewWorkAsBase(deps, repo, pr.prNumber);
      if (mergeResult.ok) {
        await applySuccess(deps, repo, pr.prNumber, "merged-new-work-as-base", mainSha);
        reconciled++;
        continue;
      }

      // Both failed — demote. Union the conflict paths so the escalation surfaces
      // every file either attempt tripped on.
      const conflictingPaths = Array.from(
        new Set([...rebaseResult.conflictingPaths, ...mergeResult.conflictingPaths]),
      );
      await applyDemoteToWork(
        {
          db: deps.db,
          github: deps.github,
          enqueueEpic: deps.enqueueEpic,
          now: deps.now,
        },
        repo,
        pr.prNumber,
        conflictingPaths,
      );
      reconciled++;
    } catch (error) {
      failed++;
      console.error(
        `[pr-divergence] ${repo} PR #${pr.prNumber} reconciliation failed: ${(error as Error).message}`,
      );
    }
  }

  return { reconciled, passed, failed, skippedForBudget: false };
}

// ── Production `gh`-backed gateway (for the daemon) ────────────────────────

async function ghSpawn(
  argv: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["gh", ...argv], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exitCode: await proc.exited };
}

async function ghJson<T>(argv: string[]): Promise<T> {
  const r = await ghSpawn(argv);
  if (r.exitCode !== 0) {
    throw new Error(`gh ${argv.join(" ")} failed: ${r.stderr.trim()}`);
  }
  try {
    return JSON.parse(r.stdout) as T;
  } catch (error) {
    throw new Error(
      `gh ${argv.join(" ")} returned unparseable JSON (${(error as Error).message}): ${r.stdout.trim()}`,
    );
  }
}

/** Parse JSON without throwing — the caller distinguishes null (PR doesn't
 *  exist OR gh emitted malformed output) from a usable object. Empty `stdout`
 *  has been observed in the wild when `gh` interleaves auth-warning text on a
 *  successful-exit; we want to log and continue, not throw. */
function safeJsonParse<T>(stdout: string): T | null {
  const trimmed = stdout.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

/**
 * Distinguish `gh`'s "this PR / branch doesn't exist" exits (which the gateway
 * surfaces as `null` so the orchestrator can pass the PR for the pass) from
 * transport/auth/rate-limit/syntax failures (which must throw so the per-PR
 * try/catch increments `failed` and the operator sees the real error). The
 * not-found shape is stable across `gh`'s outputs — both the GraphQL `Could
 * not resolve to a …` phrasing and the REST `HTTP 404` phrasing appear in
 * stderr. Anything else is a real failure.
 *
 * Deliberately narrow: we match only the two `gh`-known not-found prefixes,
 * never a bare `"not found"` substring (which could appear inside a push-
 * protection rejection or a secret-scanning notice and silently mask a real
 * failure as a PR-missing no-op).
 *
 * Exported for unit tests; the predicate is the load-bearing seam between
 * "return null" and "throw" across every gateway method.
 */
export function ghStderrIsNotFound(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return s.includes("could not resolve to a") || s.includes("http 404");
}

/**
 * Production gateway backing {@link reconcileOpenPRs}. Composes with
 * `ghGitHub`'s comment ops at the daemon-wiring site; methods that overlap
 * (`listIssueComments`, `postComment`) are intentionally absent here so the
 * daemon's spread keeps `ghGitHub` as the canonical comment poster.
 */
export const ghReconcilerGateway: Omit<ReconcilerGateway, "listIssueComments" | "postComment"> = {
  async listOpenManagedPrs(repo) {
    const rows = await ghJson<Array<{ number: number; headRefName: string }>>([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--json",
      "number,headRefName",
      "--limit",
      "100",
    ]);
    return rows
      .filter((p) => p.headRefName.startsWith(HEAD_REF_PREFIX))
      .map((p) => ({ prNumber: p.number, headRefName: p.headRefName }));
  },
  async getMainCommitSha(repo) {
    const r = await ghSpawn(["api", `/repos/${repo}/branches/main`, "--jq", ".commit.sha"]);
    if (r.exitCode !== 0) {
      if (ghStderrIsNotFound(r.stderr)) return null;
      throw new Error(`gh api branches/main for ${repo} failed: ${r.stderr.trim()}`);
    }
    const sha = r.stdout.trim();
    return sha === "" ? null : sha;
  },
  async getMergeability(repo, prNumber) {
    const r = await ghSpawn([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "mergeable,mergeStateStatus",
    ]);
    if (r.exitCode !== 0) {
      if (ghStderrIsNotFound(r.stderr)) return null;
      throw new Error(`gh pr view #${prNumber} (mergeability) failed: ${r.stderr.trim()}`);
    }
    return safeJsonParse<MergeabilityView>(r.stdout);
  },
  async getPrHeadRef(repo, prNumber) {
    const r = await ghSpawn([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "headRefName",
      "--jq",
      ".headRefName",
    ]);
    if (r.exitCode !== 0) {
      if (ghStderrIsNotFound(r.stderr)) return null;
      throw new Error(`gh pr view #${prNumber} (headRefName) failed: ${r.stderr.trim()}`);
    }
    const ref = r.stdout.trim();
    return ref === "" ? null : ref;
  },
  async getPullRequest(repo, prNumber) {
    const r = await ghSpawn(["pr", "view", String(prNumber), "--repo", repo, "--json", "isDraft"]);
    if (r.exitCode !== 0) {
      if (ghStderrIsNotFound(r.stderr)) return null;
      throw new Error(`gh pr view #${prNumber} (isDraft) failed: ${r.stderr.trim()}`);
    }
    return safeJsonParse<{ isDraft: boolean }>(r.stdout);
  },
  async convertPrToDraft(repo, prNumber) {
    const r = await ghSpawn(["pr", "ready", String(prNumber), "--repo", repo, "--undo"]);
    if (r.exitCode !== 0) {
      throw new Error(`gh pr ready --undo #${prNumber} failed: ${r.stderr.trim()}`);
    }
  },
  async listClosedSubIssues(repo, epicNumber) {
    const rows = await ghJson<Array<{ number: number; closed_at: string | null }>>([
      "api",
      `/repos/${repo}/issues/${epicNumber}/sub_issues`,
      "--paginate",
      "--jq",
      '[.[] | select(.state == "closed") | {number, closed_at}]',
    ]);
    const out: ClosedSubIssue[] = rows.map((s) => {
      // Coerce malformed `closed_at` (hand-edited rows, weird timezones) to
      // null rather than NaN — NaN sort comparisons are V8-unstable.
      const parsed = s.closed_at ? Date.parse(s.closed_at) : Number.NaN;
      return {
        number: s.number,
        closedAt: Number.isFinite(parsed) ? parsed : null,
      };
    });
    // Newest-first by closed_at; nulls sink to the end so a hand-edited row
    // doesn't shadow a real recent close.
    out.sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
    return out;
  },
  async reopenIssue(repo, issueNumber, options) {
    const argv = ["issue", "reopen", String(issueNumber), "--repo", repo];
    if (options?.comment !== undefined) {
      argv.push("--comment", options.comment);
    }
    const r = await ghSpawn(argv);
    if (r.exitCode !== 0) {
      throw new Error(`gh issue reopen #${issueNumber} failed: ${r.stderr.trim()}`);
    }
  },
};
