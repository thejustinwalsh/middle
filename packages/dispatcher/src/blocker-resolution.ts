import type { BlockedItem, ParsedState, ReadyRow } from "@middle/state-issue";

/**
 * Runtime resolution of `BlockedItem.blocker` references (#225). The recommender
 * agent records *why* an Epic is blocked (`waiting on #42`, `waiting on acme/b#7`)
 * but cannot consume that reference — so a repo-A Epic blocked on a repo-B Epic
 * stays blocked forever even after repo B closes. This module is the deterministic
 * post-agent pass that closes that hole: it parses each blocker, resolves issue
 * references against live state, and reclassifies the blocked item.
 *
 * Pure (no gateway/`gh`/db): the live-state lookups are injected as
 * {@link BlockerResolver.resolveIssue}, so the reclassification logic is fully
 * unit-testable against an in-memory issue table.
 */

/** The open/closed state + title of a resolved blocker (mirrors `EpicGateway.IssueState`). */
export type IssueState = {
  state: "open" | "closed";
  title: string;
};

/**
 * A parsed `BlockedItem.blocker` reference. `ref` is the canonical reference
 * string (`#42` or `acme/b#7`) — the token to re-render and to name in a
 * `(stale blocker: <ref>)` suffix, with any prior `(…)` annotation stripped.
 */
export type BlockerRef =
  | { kind: "same-repo"; issue: number; ref: string }
  | { kind: "cross-repo"; repo: string; issue: number; ref: string }
  | { kind: "non-issue" };

/** What {@link resolveBlockers} needs to resolve references and build Ready rows. */
export type BlockerResolver = {
  /** The state issue's own repo (`owner/name`) — same-repo `#<n>` refs resolve against this. */
  repo: string;
  /** Adapter assigned to an unblocked item's new Ready row (the repo's default adapter). */
  defaultAdapter: string;
  /**
   * Resolve a blocker's live state + title; `null` when unresolvable (404 / deleted
   * in github mode, no Epic file in file mode) → a *stale* blocker. `repo` is the
   * blocker's repo (the state issue's repo for a same-repo ref, the cross-repo's
   * `owner/name` for a cross-repo ref).
   */
  resolveIssue: (repo: string, issue: number) => Promise<IssueState | null>;
  /**
   * Best-effort metadata for an unblocked Epic in *this* repo, for an accurate
   * Ready row (title + open sub-issue count). Prefetched from `listOpenEpics`;
   * `undefined` for an issue not in that set (e.g. a standalone issue), in which
   * case the title falls back to {@link resolveIssue} and the count to 1.
   */
  selfEpic?: (issue: number) => { title: string; openSubIssues: number } | undefined;
};

// A blocker token: an optional `<owner>/<repo>` prefix, then `#<n>`, ending at a
// space or end-of-string (so a trailing ` (title)` / ` (stale blocker: …)`
// annotation is not captured into the ref). Cross-repo is tried first.
const CROSS_REPO_RE = /^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#(\d+)(?=$|\s)/;
const SAME_REPO_RE = /^#(\d+)(?=$|\s)/;

/**
 * Parse a `BlockedItem.blocker` string into a structured reference. A backticked
 * description or any free text without a leading `#<n>` / `<owner>/<repo>#<n>`
 * token is `non-issue` (stays blocked, never resolved). A trailing annotation is
 * ignored so re-resolution is idempotent.
 */
export function parseBlockerRef(blocker: string): BlockerRef {
  const trimmed = blocker.trim();
  const cross = CROSS_REPO_RE.exec(trimmed);
  if (cross) {
    return {
      kind: "cross-repo",
      repo: cross[1]!,
      issue: Number(cross[2]),
      ref: `${cross[1]}#${cross[2]}`,
    };
  }
  const same = SAME_REPO_RE.exec(trimmed);
  if (same) return { kind: "same-repo", issue: Number(same[1]), ref: `#${same[1]}` };
  return { kind: "non-issue" };
}

/** Collapse whitespace and drop the `·` separator so an injected title can't break the
 *  line's ` · ` field split or its single-line shape. */
function sanitizeTitle(title: string): string {
  return title.replace(/·/g, "-").replace(/\s+/g, " ").trim();
}

/** Truncate to ≤60 chars with a trailing ellipsis (the schema's Epic-cell rule). */
function truncate60(title: string): string {
  return title.length <= 60 ? title : `${title.slice(0, 59)}…`;
}

/**
 * Reclassify a parsed state's `Blocked` items by resolving each issue reference
 * against live state:
 * - **blocker closed** → the item moves to `Ready to dispatch` (a best-effort row
 *   the next full recommender run re-ranks).
 * - **blocker open** → stays `Blocked`, its blocker annotated `<ref> (<title>)`.
 * - **blocker unresolvable** → stays `Blocked` with a `<ref> (stale blocker: <ref>)`
 *   suffix.
 * - **non-issue (backticked) blocker** → left untouched.
 *
 * Returns the original `state` object unchanged when nothing reclassified (so a
 * no-resolvable-blockers pass is a cheap no-op the caller can skip writing).
 */
export async function resolveBlockers(
  state: ParsedState,
  deps: BlockerResolver,
): Promise<ParsedState> {
  const stillBlocked: BlockedItem[] = [];
  const unblocked: BlockedItem[] = [];
  let changed = false;

  for (const item of state.blocked) {
    const ref = parseBlockerRef(item.blocker);
    if (ref.kind === "non-issue") {
      stillBlocked.push(item);
      continue;
    }
    const blockerRepo = ref.kind === "cross-repo" ? ref.repo : deps.repo;
    const resolved = await deps.resolveIssue(blockerRepo, ref.issue);

    if (resolved === null) {
      const blocker = `${ref.ref} (stale blocker: ${ref.ref})`;
      if (blocker !== item.blocker) changed = true;
      stillBlocked.push({ ...item, blocker });
      continue;
    }
    if (resolved.state === "open") {
      // Annotate with the resolved title, truncated like an Epic cell. An empty /
      // whitespace-only title (sanitizes to "") must NOT produce `#42 ()` — that
      // fails the very `validate` the verify step runs next — so fall back to the
      // bare ref (which re-resolves identically on the next tick).
      const title = truncate60(sanitizeTitle(resolved.title));
      const blocker = title === "" ? ref.ref : `${ref.ref} (${title})`;
      if (blocker !== item.blocker) changed = true;
      stillBlocked.push({ ...item, blocker });
      continue;
    }
    // Blocker closed → unblock.
    changed = true;
    unblocked.push(item);
  }

  if (!changed) return state;

  // Build a Ready row for each unblocked item. The blocked Epic's own title +
  // sub-issue count come from `selfEpic` (prefetched, accurate) when available,
  // else fall back to resolving the Epic itself (title) with a count of 1.
  const newReadyRows: ReadyRow[] = [];
  for (const item of unblocked) {
    const meta = deps.selfEpic?.(item.issue);
    let title: string;
    let subIssues: number;
    if (meta) {
      title = meta.title;
      subIssues = Math.max(1, meta.openSubIssues);
    } else {
      const self = await deps.resolveIssue(deps.repo, item.issue);
      title = self?.title ?? `Epic #${item.issue}`;
      subIssues = 1;
    }
    const ref = parseBlockerRef(item.blocker);
    const reason =
      ref.kind === "non-issue" ? "blocker resolved" : `unblocked — \`${ref.ref}\` closed`;
    newReadyRows.push({
      rank: 0, // re-ranked below
      epic: `#${item.issue} ${truncate60(sanitizeTitle(title))}`,
      adapter: deps.defaultAdapter,
      subIssues,
      reason,
    });
  }

  // Append the unblocked rows after the existing ones, then renumber sequentially.
  const readyToDispatch = [...state.readyToDispatch, ...newReadyRows].map((row, i) => ({
    ...row,
    rank: i + 1,
  }));

  return { ...state, readyToDispatch, blocked: stillBlocked };
}
