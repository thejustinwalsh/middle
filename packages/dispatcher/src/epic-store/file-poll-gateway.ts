/**
 * `filePollGateway` — the file-backed `PollGateway`. Its load-bearing method is
 * `listIssueComments`: it maps the Epic file's conversation into the poller's
 * `IssueComment[]` with `authorIsBot` derived **structurally** from the marker
 * (`question`/`dispatch-event` → bot; `answer` → human) rather than from an
 * author-login heuristic — that's what closes #178's class for file mode (the
 * poller's `classifyNewHumanReply` keys resume off `!authorIsBot`).
 *
 * The PR-poll methods are GitHub-native: `getRateLimit` delegates straight to gh.
 * `findPrForEpic`/`findEpicPrLifecycle` delegate for a numeric ref but return
 * `null` for a file-mode slug — GitHub's PR-finders resolve by `Closes #<number>`,
 * which a file Epic (slug, no GitHub issue) can't carry. File-mode review-resume
 * rides Phase 2's watcher work (see `planning/issues/190/decisions.md`).
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
 * else delegates to the injected `gh` backend. The PR-poll methods (`findPrForEpic`,
 * `findEpicPrLifecycle`) delegate only for a numeric ref and return `null` for a
 * file-mode slug (no `Closes #N` linkage); `getRateLimit` always delegates to `gh`.
 */
export function makeFilePollGateway(deps: FilePollGatewayDeps): FilePollGateway {
  const { epicsDir, gh } = deps;
  return {
    pollFileSignals: (sinceMs) => pollFileSignals(epicsDir, sinceMs),
    async listIssueComments(repo, ref): Promise<IssueComment[]> {
      if (!epicFileExists(epicsDir, ref)) return gh.listIssueComments(repo, ref);
      const epic = readEpicFile(epicsDir, ref);
      if (!epic) return [];
      return conversationToPollComments(epic.conversation);
    },

    async findPrForEpic(repo, epicRef): Promise<PrSnapshot | null> {
      // A file-mode slug has no `Closes #<number>` linkage gh can search.
      return isNumericRef(epicRef) ? gh.findPrForEpic(repo, epicRef) : null;
    },

    async findEpicPrLifecycle(repo, epicRef): Promise<EpicPrLifecycle | null> {
      return isNumericRef(epicRef) ? gh.findEpicPrLifecycle(repo, epicRef) : null;
    },

    getRateLimit: () => gh.getRateLimit(),
  };
}
