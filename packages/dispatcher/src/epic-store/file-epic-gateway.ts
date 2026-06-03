/**
 * `fileEpicGateway` — the file-backed `EpicGateway`. A **composite**: Epic-shaped
 * methods read/write the local Epic file (via the round-trip-pure
 * `epic-file/{parser,renderer}`); PR-shaped and github-native-issue methods
 * delegate to an injected `gh` backend (PRs/reviews/CI are GitHub-native in both
 * modes — the "hybrid" of the design).
 *
 * Routing: a method that takes a `ref` checks whether an Epic file exists for it
 * (`epicFileExists`). A slug ("rollout-epic-store") resolves to the file; a
 * numeric PR/issue ref ("42", with no `42.md`) falls through to the gh backend.
 * This is what lets one gateway serve both an Epic-file comment and a PR comment.
 */

import type { IssueComment } from "../gates/plan-comment.ts";
import type { CommentAuthor, EpicGateway, EpicListItem, PullRequest } from "../github.ts";
import { epicFileExists, listEpicSlugs, readEpicFile, writeEpicFile } from "./epic-file-io.ts";
import type { ConversationEntry, EpicFile } from "./epic-file/types.ts";

/** The synthetic login the file store attributes bot-authored conversation entries to. */
export const FILE_AGENT_LOGIN = "middle-agent";
/** The synthetic login a human `answer` block is attributed to. */
export const FILE_HUMAN_LOGIN = "human";

export type FileEpicGatewayDeps = {
  /** Absolute path to this repo's Epic directory (`planning/epics`). */
  epicsDir: string;
  /** Backend for PR-shaped + github-native-issue methods (the hybrid half). */
  gh: EpicGateway;
  /** Wall-clock for the dispatch-event timestamp; injectable for deterministic tests. */
  now?: () => Date;
};

/** Build the `file://` comment URL for a conversation entry — the address
 *  `getCommentAuthor` resolves back to agent/human. */
function commentUrl(epicsDir: string, slug: string, fragment: string): string {
  return `file://${epicsDir}/${slug}.md#${fragment}`;
}

/** Map an Epic file's conversation into the flat `{authorLogin, body, url}` comment
 *  list `EpicGateway.listIssueComments` returns (the plan-comment gate reads this). */
function conversationToComments(
  epicsDir: string,
  slug: string,
  conversation: ConversationEntry[],
): IssueComment[] {
  const comments: IssueComment[] = [];
  conversation.forEach((entry, i) => {
    if (entry.kind === "dispatch-event") {
      comments.push({
        authorLogin: FILE_AGENT_LOGIN,
        body: entry.body,
        url: commentUrl(epicsDir, slug, `dispatch-event-${i}`),
      });
    } else if (entry.kind === "question") {
      comments.push({
        authorLogin: FILE_AGENT_LOGIN,
        body: entry.body,
        url: commentUrl(epicsDir, slug, `question-${entry.id}`),
      });
      if (entry.answer) {
        comments.push({
          authorLogin: FILE_HUMAN_LOGIN,
          body: entry.answer.body,
          url: commentUrl(epicsDir, slug, `answer-${entry.id}`),
        });
      }
    }
  });
  return comments;
}

export function makeFileEpicGateway(deps: FileEpicGatewayDeps): EpicGateway {
  const { epicsDir, gh } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    // ── delegated to gh (PR-shaped + github-native; hybrid half) ──────────────
    getPullRequest: (repo, prNumber) => gh.getPullRequest(repo, prNumber),
    editPullRequestBody: (repo, prNumber, body) => gh.editPullRequestBody(repo, prNumber, body),
    // editComment edits a GitHub PR/issue comment in place (gate-evidence upsert),
    // which is github-native in file mode too — delegate.
    editComment: (repo, commentId, body) => gh.editComment(repo, commentId, body),
    listOpenIssues: (repo) => gh.listOpenIssues(repo),
    listMergedPrsClosingRefs: (repo) => gh.listMergedPrsClosingRefs(repo),
    createIssue: (repo, issue) => gh.createIssue(repo, issue),

    // ── file-backed (Epic-shaped), with gh fallback for non-Epic refs ─────────

    async listOpenEpics(_repo): Promise<EpicListItem[]> {
      const out: EpicListItem[] = [];
      for (const slug of listEpicSlugs(epicsDir)) {
        const epic = readEpicFile(epicsDir, slug);
        if (!epic || epic.meta.closed) continue;
        out.push({
          ref: epic.meta.slug,
          number: null, // file-mode Epics have a slug, not a GitHub issue number
          title: epic.title,
          state: "open",
          labels: epic.meta.labels ?? [],
          subTotal: epic.subIssues.length,
          subClosed: epic.subIssues.filter((s) => s.checked).length,
        });
      }
      return out;
    },

    async listIssueComments(repo, ref): Promise<IssueComment[]> {
      if (!epicFileExists(epicsDir, ref)) return gh.listIssueComments(repo, ref);
      const epic = readEpicFile(epicsDir, ref);
      if (!epic) return [];
      return conversationToComments(epicsDir, ref, epic.conversation);
    },

    async getCommentAuthor(repo, commentUrlArg): Promise<CommentAuthor | null> {
      if (!commentUrlArg.startsWith("file://")) return gh.getCommentAuthor(repo, commentUrlArg);
      // A `#answer-N` fragment is a human reply; everything else (question,
      // dispatch-event) is the agent/dispatcher — the structural discrimination
      // that closes #178's class for file mode (no author-login heuristics).
      if (/#answer-\d+$/.test(commentUrlArg)) {
        return { login: FILE_HUMAN_LOGIN, isBot: false };
      }
      return { login: FILE_AGENT_LOGIN, isBot: true };
    },

    async getIssueLabels(repo, ref): Promise<string[]> {
      if (!epicFileExists(epicsDir, ref)) return gh.getIssueLabels(repo, ref);
      const epic = readEpicFile(epicsDir, ref);
      return epic?.meta.labels ?? [];
    },

    async addLabel(repo, ref, label): Promise<void> {
      if (!epicFileExists(epicsDir, ref)) {
        await gh.addLabel(repo, ref, label);
        return;
      }
      const epic = readEpicFile(epicsDir, ref);
      if (!epic) return;
      const labels = epic.meta.labels ?? [];
      if (labels.includes(label)) return; // no-op if already present (gateway contract)
      writeEpicFile(epicsDir, ref, { ...epic, meta: { ...epic.meta, labels: [...labels, label] } });
    },

    async closeIssue(repo, ref, comment): Promise<void> {
      if (!epicFileExists(epicsDir, ref)) {
        await gh.closeIssue(repo, ref, comment);
        return;
      }
      const epic = readEpicFile(epicsDir, ref);
      if (!epic) return;
      const closed = appendDispatchEvent(epic, now().toISOString(), "closed", comment);
      writeEpicFile(epicsDir, ref, { ...closed, meta: { ...closed.meta, closed: true } });
    },

    async postComment(repo, ref, body): Promise<void> {
      if (!epicFileExists(epicsDir, ref)) {
        await gh.postComment(repo, ref, body);
        return;
      }
      const epic = readEpicFile(epicsDir, ref);
      if (!epic) return;
      writeEpicFile(epicsDir, ref, appendDispatchEvent(epic, now().toISOString(), "comment", body));
    },

    async findEpicPr(repo, epicRef): Promise<PullRequest | null> {
      const epic = readEpicFile(epicsDir, epicRef);
      // The Epic file stamps `pr:` in its meta when the PR opens (durable backup
      // for the PR-body marker). No file or no stamped PR → no PR yet.
      if (!epic || epic.meta.pr === undefined) return null;
      return gh.getPullRequest(repo, epic.meta.pr);
    },
  };
}

/** Append a `<!-- middle:dispatch-event -->` entry to an Epic's conversation. */
function appendDispatchEvent(
  epic: EpicFile,
  ts: string,
  eventKind: string,
  body: string,
): EpicFile {
  return {
    ...epic,
    conversation: [...epic.conversation, { kind: "dispatch-event", ts, eventKind, body }],
  };
}
