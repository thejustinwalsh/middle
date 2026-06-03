/**
 * @packageDocumentation
 * @module @middle/dispatcher/epic-store
 *
 * File-backed Epic store: the parallel implementations of the dispatcher's three
 * DI'd gateway interfaces, plus the per-repo bootstrap selector that picks the
 * github-backed or file-backed trio.
 *
 * Public surface:
 * - `buildGitHubGateways` — today's `gh`-backed trio, lifted into a named helper
 * - `buildFileGateways` — the file-backed trio for one repo (Epic dir + state file)
 * - `makeRoutingEpicGateway` — a daemon-global `EpicGateway` that delegates each
 *   call to the per-repo file or gh backend, keyed on the method's `repo` arg
 * - `appendQuestion` — append a `<!-- middle:question -->` block to an Epic file
 *   (the file-mode `postQuestion` endpoint)
 * - `make{File,}…Gateway` re-exports from the gateway modules
 *
 * Where things live:
 * - `index.ts` — factories + the per-repo router + `appendQuestion`
 * - `file-epic-gateway.ts` / `file-state-gateway.ts` / `file-poll-gateway.ts` — the gateways
 * - `epic-file-io.ts` — disk read/parse + render/atomic-write
 * - `epic-file/` — the pure parser/renderer/types/markers (round-trip invariant)
 *
 * Gotchas:
 * - The daemon registers ONE implementation workflow with ONE deps, but mode is
 *   per-repo — so the wired gateway is a *router* that reads `repo_config` per call
 *   and delegates by `repo`. A file gateway is a composite: Epic methods are
 *   file-backed, PR/github-native methods delegate to gh.
 *
 * claude-md: false
 */

import type { Database } from "bun:sqlite";
import { ghGitHub, type EpicGateway } from "../github.ts";
import { ghPollGateway } from "../poller-gateway.ts";
import { ghStateIssueGateway, type StateGateway } from "../state-issue.ts";
import type { PollGateway } from "../poller.ts";
import { readEpicStoreConfig } from "../repo-config.ts";
import { join } from "node:path";
import { readEpicFile, writeEpicFile } from "./epic-file-io.ts";
import { makeFileEpicGateway } from "./file-epic-gateway.ts";
import { makeFilePollGateway } from "./file-poll-gateway.ts";
import { makeFileStateGateway } from "./file-state-gateway.ts";

export { makeFileEpicGateway } from "./file-epic-gateway.ts";
export { makeFilePollGateway } from "./file-poll-gateway.ts";
export { makeFileStateGateway } from "./file-state-gateway.ts";

/** The three gateways a dispatch path needs, behind their shared interfaces. */
export type GatewayTrio = {
  epicGateway: EpicGateway;
  stateGateway: StateGateway;
  pollGateway: PollGateway;
};

/** Today's `gh`-backed trio, lifted into a named helper (the github-mode wiring). */
export function buildGitHubGateways(over?: {
  ghEpic?: EpicGateway;
  ghState?: StateGateway;
  ghPoll?: PollGateway;
}): GatewayTrio {
  return {
    epicGateway: over?.ghEpic ?? ghGitHub,
    stateGateway: over?.ghState ?? ghStateIssueGateway,
    pollGateway: over?.ghPoll ?? ghPollGateway,
  };
}

/**
 * The file-backed trio for one repo. Epic/state methods read/write local files
 * under `epicsDir`/`stateFile`; PR-shaped + github-native methods delegate to the
 * injected `gh` backends (the hybrid). `epicsDir`/`stateFile` are absolute.
 */
export function buildFileGateways(args: {
  epicsDir: string;
  stateFile: string;
  ghEpic?: EpicGateway;
  ghPoll?: PollGateway;
}): GatewayTrio {
  const ghEpic = args.ghEpic ?? ghGitHub;
  const ghPoll = args.ghPoll ?? ghPollGateway;
  return {
    epicGateway: makeFileEpicGateway({ epicsDir: args.epicsDir, gh: ghEpic }),
    stateGateway: makeFileStateGateway({ stateFile: args.stateFile }),
    pollGateway: makeFilePollGateway({ epicsDir: args.epicsDir, gh: ghPoll }),
  };
}

/** Resolve a repo's file-mode gateway trio (absolute paths from `resolveRepoPath`),
 *  or the github trio when the repo isn't in file mode. */
function trioForRepo(
  db: Database,
  repo: string,
  resolveRepoPath: (repo: string) => string,
  gh: { epic: EpicGateway; poll: PollGateway },
): GatewayTrio {
  const cfg = readEpicStoreConfig(db, repo);
  if (cfg.mode !== "file") {
    return buildGitHubGateways({ ghEpic: gh.epic, ghPoll: gh.poll });
  }
  const root = resolveRepoPath(repo);
  return buildFileGateways({
    epicsDir: join(root, cfg.epicsDir),
    stateFile: join(root, cfg.stateFile),
    ghEpic: gh.epic,
    ghPoll: gh.poll,
  });
}

/**
 * A daemon-global `EpicGateway` that routes each call to the right per-repo
 * backend (file or gh), keyed on the method's `repo` argument. The daemon
 * registers one implementation workflow with one deps, but Epic-store mode is
 * per-repo — this router is what lets repo A run github mode while repo B runs
 * file mode under the same daemon. Per-repo file gateways are built lazily and
 * cached (config is read fresh per call, so a mode flip is picked up on the next
 * dispatch without a daemon restart — the cache only memoizes the file gateway
 * object, which is stateless).
 */
export function makeRoutingEpicGateway(deps: {
  db: Database;
  resolveRepoPath: (repo: string) => string;
  ghEpic?: EpicGateway;
  ghPoll?: PollGateway;
}): EpicGateway {
  const ghEpic = deps.ghEpic ?? ghGitHub;
  const ghPoll = deps.ghPoll ?? ghPollGateway;
  const gatewayFor = (repo: string): EpicGateway =>
    trioForRepo(deps.db, repo, deps.resolveRepoPath, { epic: ghEpic, poll: ghPoll }).epicGateway;
  return {
    listOpenEpics: (repo) => gatewayFor(repo).listOpenEpics(repo),
    listIssueComments: (repo, ref) => gatewayFor(repo).listIssueComments(repo, ref),
    findEpicPr: (repo, epicRef) => gatewayFor(repo).findEpicPr(repo, epicRef),
    getPullRequest: (repo, prNumber) => gatewayFor(repo).getPullRequest(repo, prNumber),
    editPullRequestBody: (repo, prNumber, body) =>
      gatewayFor(repo).editPullRequestBody(repo, prNumber, body),
    postComment: (repo, ref, body) => gatewayFor(repo).postComment(repo, ref, body),
    editComment: (repo, commentId, body) => gatewayFor(repo).editComment(repo, commentId, body),
    getCommentAuthor: (repo, url) => gatewayFor(repo).getCommentAuthor(repo, url),
    getIssueLabels: (repo, ref) => gatewayFor(repo).getIssueLabels(repo, ref),
    listOpenIssues: (repo) => gatewayFor(repo).listOpenIssues(repo),
    addLabel: (repo, ref, label) => gatewayFor(repo).addLabel(repo, ref, label),
    listMergedPrsClosingRefs: (repo) => gatewayFor(repo).listMergedPrsClosingRefs(repo),
    closeIssue: (repo, ref, comment) => gatewayFor(repo).closeIssue(repo, ref, comment),
    createIssue: (repo, issue) => gatewayFor(repo).createIssue(repo, issue),
  };
}

/**
 * Append a `<!-- middle:question -->` block to an Epic file's conversation — the
 * file-mode `postQuestion` endpoint (the agent-side of #178's class, structurally
 * distinct from any human-written `<!-- middle:answer -->`). The renderer is the
 * sole writer of the strict marker attributes, so the round-trip survives.
 */
export function appendQuestion(
  epicsDir: string,
  slug: string,
  opts: { question: string; context?: string; kind: "question" | "complexity"; now?: () => Date },
): void {
  const epic = readEpicFile(epicsDir, slug);
  if (!epic)
    throw new Error(`cannot post question: no Epic file for slug "${slug}" in ${epicsDir}`);
  const nextId =
    epic.conversation.reduce((max, e) => (e.kind === "question" ? Math.max(max, e.id) : max), 0) +
    1;
  const ts = (opts.now ?? (() => new Date()))().toISOString();
  const body = opts.context ? `${opts.question}\n\n${opts.context}` : opts.question;
  writeEpicFile(epicsDir, slug, {
    ...epic,
    conversation: [
      ...epic.conversation,
      { kind: "question", id: nextId, status: "open", ts, questionKind: opts.kind, body },
    ],
  });
}
