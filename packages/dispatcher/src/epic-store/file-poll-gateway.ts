/**
 * `filePollGateway` — the file-backed `PollGateway`. Its load-bearing method is
 * `listIssueComments`: it maps the Epic file's conversation into the poller's
 * `IssueComment[]` with `authorIsBot` derived **structurally** from the marker
 * (`question`/`dispatch-event` → bot; `answer` → human) rather than from an
 * author-login heuristic — that's what closes #178's class for file mode (the
 * poller's `classifyNewHumanReply` keys resume off `!authorIsBot`).
 *
 * The PR-poll methods are GitHub-native: `getRateLimit`, `prSnapshot`, and
 * `prLifecycle` delegate straight to gh (the PR exists on GitHub in both modes).
 * For a **numeric** ref `findPrForEpic`/`findEpicPrLifecycle` delegate to gh's
 * `Closes #<number>` finders; for a **file-mode slug** (no `Closes #` linkage)
 * they resolve the Epic's PR from the Epic file's durable `meta.pr` stamp and
 * fetch by number — that's what makes `review-changes`/`CHANGES_REQUESTED` (and
 * the merged/closed reconcile) resume work in file mode, alongside the
 * file-watcher's question-resume (#200; see `planning/issues/200/decisions.md`).
 */

import type { EpicPrLifecycle, IssueComment, PollGateway, PrSnapshot } from "../poller.ts";
import { FILE_AGENT_LOGIN, FILE_HUMAN_LOGIN } from "./file-epic-gateway.ts";
import { epicFileExists, readEpicFile } from "./epic-file-io.ts";
import { type FileAnswerSignal, pollFileSignals } from "./watcher.ts";
import type { ConversationEntry } from "./epic-file/types.ts";

/** The file poll gateway plus the Phase-2 file-watcher method (not on the shared interface). */
export type FilePollGateway = PollGateway & {
  /** Newly-answered questions (open question → non-empty answer) in files changed since `sinceMs`. */
  pollFileSignals(sinceMs: number): FileAnswerSignal[];
};

export type FilePollGatewayDeps = {
  /** Absolute path to this repo's Epic directory (`planning/epics`). */
  epicsDir: string;
  /** Backend for the GitHub-native PR-poll methods. */
  gh: PollGateway;
};

/** `true` when the ref is a numeric string — the only kind gh's `Closes #N`
 *  PR-finders can resolve (a file-mode slug is not). */
function isNumericRef(ref: string): boolean {
  return /^\d+$/.test(ref.trim());
}

/** Map an Epic file's conversation into the poller's `IssueComment[]`, with
 *  `authorIsBot` discriminated by marker kind. */
function conversationToPollComments(conversation: ConversationEntry[]): IssueComment[] {
  const out: IssueComment[] = [];
  conversation.forEach((entry, i) => {
    if (entry.kind === "dispatch-event") {
      out.push({
        id: i,
        authorLogin: FILE_AGENT_LOGIN,
        authorIsBot: true,
        createdAt: Date.parse(entry.ts),
        body: entry.body,
      });
    } else if (entry.kind === "question") {
      out.push({
        id: entry.id,
        authorLogin: FILE_AGENT_LOGIN,
        authorIsBot: true,
        createdAt: Date.parse(entry.ts),
        body: entry.body,
      });
      if (entry.answer) {
        // The answer block has no own timestamp (the file-watcher uses file mtime,
        // not this createdAt); inherit the question's ts. `authorIsBot: false` is
        // the human-reply signal the poller resumes on.
        out.push({
          id: entry.id,
          authorLogin: FILE_HUMAN_LOGIN,
          authorIsBot: false,
          createdAt: Date.parse(entry.ts),
          body: entry.answer.body,
        });
      }
    }
  });
  return out;
}

/**
 * Build the file-backed `PollGateway` (plus the Phase-2 `pollFileSignals`) for one
 * repo's Epic directory. `listIssueComments` reads the Epic file's conversation when
 * a file exists for the ref (deriving `authorIsBot` structurally from marker kind),
 * else delegates to the injected `gh` backend. The PR finders (`findPrForEpic`,
 * `findEpicPrLifecycle`) delegate to gh for a numeric ref; for a file-mode slug they
 * resolve the PR from the Epic file's `meta.pr` and fetch by number via gh's
 * `prSnapshot`/`prLifecycle` (no stamped PR yet → `null`). `prSnapshot`/`prLifecycle`/
 * `getRateLimit` always delegate to `gh` (PRs are GitHub-native in both modes).
 */
export function makeFilePollGateway(deps: FilePollGatewayDeps): FilePollGateway {
  const { epicsDir, gh } = deps;
  /** The PR number stamped on the Epic file's `meta.pr`, or null (no file / no stamp). */
  function stampedPr(epicRef: string): number | null {
    const epic = readEpicFile(epicsDir, epicRef);
    return epic?.meta.pr ?? null;
  }
  return {
    pollFileSignals: (sinceMs) => pollFileSignals(epicsDir, sinceMs),
    async listIssueComments(repo, ref): Promise<IssueComment[]> {
      if (!epicFileExists(epicsDir, ref)) return gh.listIssueComments(repo, ref);
      const epic = readEpicFile(epicsDir, ref);
      if (!epic) return [];
      return conversationToPollComments(epic.conversation);
    },

    async findPrForEpic(repo, epicRef): Promise<PrSnapshot | null> {
      // Numeric ref → gh's `Closes #<n>` finder. File-mode slug → resolve the PR
      // from the Epic file's `meta.pr` stamp and fetch it by number.
      if (isNumericRef(epicRef)) return gh.findPrForEpic(repo, epicRef);
      const prNumber = stampedPr(epicRef);
      return prNumber === null ? null : gh.prSnapshot(repo, prNumber);
    },

    async findEpicPrLifecycle(repo, epicRef): Promise<EpicPrLifecycle | null> {
      if (isNumericRef(epicRef)) return gh.findEpicPrLifecycle(repo, epicRef);
      const prNumber = stampedPr(epicRef);
      return prNumber === null ? null : gh.prLifecycle(repo, prNumber);
    },

    prSnapshot: (repo, prNumber) => gh.prSnapshot(repo, prNumber),
    prLifecycle: (repo, prNumber) => gh.prLifecycle(repo, prNumber),
    getRateLimit: () => gh.getRateLimit(),
  };
}
