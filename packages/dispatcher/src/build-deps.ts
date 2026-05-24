import type { Database } from "bun:sqlite";
import type { AgentAdapter } from "@middle/core";
import { makePrReadyGateHandler, type PrReadyGateHandler } from "./gates/pr-ready-handler.ts";
import type { PlanCommentReader } from "./gates/plan-comment.ts";
import { ghGitHub, type GitHubGateway, resolveAgentLogin as ghResolveAgentLogin } from "./github.ts";
import type { SessionGate } from "./hook-server.ts";
import { killSession, newSession, sendEnter, sendText } from "./tmux.ts";
import { findActiveWorkflowBySession, getWorkflow } from "./workflow-record.ts";
import type { ImplementationDeps, ImplementationInput } from "./workflows/implementation.ts";
import { createWorktree, destroyWorktree } from "./worktree.ts";

/** The slice of {@link GitHubGateway} the deps factory reads. */
type DepsGitHub = Pick<GitHubGateway, "findEpicPr" | "getCommentAuthor">;

/**
 * What the caller binds for the HookServer-dependent part of the deps. The
 * factory builds `prReadyGate`, hands it here, and the caller constructs (and
 * starts) the `HookServer` from it — returning the live {@link SessionGate} and
 * the localhost `dispatcherUrl`. This breaks the gate→server→deps value cycle
 * (the server *is* the SessionGate but needs the gate to exist) while keeping
 * `new HookServer(store, prReadyGate)` in the caller and resolving an ephemeral
 * (`port: 0`) `dispatcherUrl` only after `start()`.
 */
export type BindServer = (prReadyGate: PrReadyGateHandler) => {
  sessionGate: SessionGate;
  dispatcherUrl: string;
};

/** Inputs for {@link buildImplementationDeps}. */
export type BuildImplementationDepsArgs = {
  db: Database;
  /**
   * `owner/name` — a *fallback* for resolving a deferral comment's author. The
   * comment's repo is taken from the comment URL itself (URL-authoritative), so
   * the daemon, which serves many repos, can omit this; the single-repo
   * standalone path passes its slug.
   */
  repoSlug?: string;
  getAdapter: (name: string) => AgentAdapter;
  resolveRepoPath: (repo: string) => string;
  worktreeRoot: string;
  /**
   * Enqueue a continuation execution for a resume. Injected by the caller so the
   * factory stays engine-free: prod wires `engine.start("implementation", input)`
   * on the long-lived engine; tests wire their own.
   */
  enqueueContinuation: (input: ImplementationInput) => Promise<void>;
  /** Construct + start the HookServer from the gate; see {@link BindServer}. */
  bindServer: BindServer;
  /** GitHub reads — defaults to the real `gh`-backed gateway. Injectable for tests. */
  github?: DepsGitHub;
  /** Plan-comment guard reader — defaults to {@link ghGitHub}. */
  planCommentReader?: PlanCommentReader;
  /** Resolve the agent's `gh` login once — defaults to the real resolver. */
  resolveAgentLogin?: () => Promise<string | undefined>;
  /** Post the agent's open question on the Epic when it parks (optional). */
  postQuestion?: ImplementationDeps["postQuestion"];
  launchTimeoutMs?: number;
  stopTimeoutMs?: number;
  reviewRoundCap?: number;
  maxNudges?: number;
  nudgeStopTimeoutMs?: number;
};

/**
 * Build the `ImplementationDeps` and the PR-ready gate handler the
 * `implementation` workflow needs, with one canonical collaborator wiring. The
 * daemon (`main.ts`) consumes it to host the workflow on its long-lived engine.
 *
 * Returns `{ deps, prReadyGate }`: `deps` is passed to
 * `createImplementationWorkflow`, and `prReadyGate` is the handler the caller
 * passes to `new HookServer(store, prReadyGate)` (done inside {@link BindServer}).
 * The factory constructs no engine — the engine arrives via `enqueueContinuation`.
 */
export async function buildImplementationDeps(
  args: BuildImplementationDepsArgs,
): Promise<{ deps: ImplementationDeps; prReadyGate: PrReadyGateHandler }> {
  const github = args.github ?? ghGitHub;
  const resolveLogin = args.resolveAgentLogin ?? ghResolveAgentLogin;

  // The PR-ready gate resolves a session to its Epic via the workflow row, then
  // reads the Epic PR through `gh`.
  const prReadyGate = makePrReadyGateHandler({
    resolveSession: (sessionName) => {
      const active = findActiveWorkflowBySession(args.db, sessionName);
      if (!active) return null;
      const workflow = getWorkflow(args.db, active.id);
      if (!workflow || workflow.epicNumber === null) return null;
      return { repo: workflow.repo, epicNumber: workflow.epicNumber };
    },
    findEpicPr: (repo, epicNumber) => github.findEpicPr(repo, epicNumber),
    resolveCommentAuthor: (url) => github.getCommentAuthor(args.repoSlug ?? "", url),
  });

  // The agent posts to GitHub as the dispatcher's gh identity; resolve it once
  // so the plan-comment guard can restrict its match to the agent's comments.
  const agentLogin = await resolveLogin();

  const { sessionGate, dispatcherUrl } = args.bindServer(prReadyGate);

  const deps: ImplementationDeps = {
    db: args.db,
    getAdapter: args.getAdapter,
    sessionGate,
    tmux: { newSession, sendText, sendEnter, killSession },
    worktree: { createWorktree, destroyWorktree },
    resolveRepoPath: args.resolveRepoPath,
    worktreeRoot: args.worktreeRoot,
    dispatcherUrl,
    enqueueContinuation: args.enqueueContinuation,
    planCommentReader: args.planCommentReader ?? ghGitHub,
    agentLogin,
    // Positive done-signal (#80): a bare-stop only completes if the Epic
    // already has a ready, non-draft PR.
    epicPrReadiness: async (repo, epicNumber) => {
      const pr = await github.findEpicPr(repo, epicNumber);
      return { exists: pr !== null, isDraft: pr?.isDraft ?? false };
    },
    postQuestion: args.postQuestion,
    launchTimeoutMs: args.launchTimeoutMs,
    stopTimeoutMs: args.stopTimeoutMs,
    reviewRoundCap: args.reviewRoundCap,
    maxNudges: args.maxNudges,
    nudgeStopTimeoutMs: args.nudgeStopTimeoutMs,
  };

  return { deps, prReadyGate };
}
