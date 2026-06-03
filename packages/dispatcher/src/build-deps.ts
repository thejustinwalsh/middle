import type { Database } from "bun:sqlite";
import type { AgentAdapter } from "@middle/core";
import { type GateRunReport, runGates } from "./gates/gate-runner.ts";
import { makePrReadyGateHandler, type PrReadyGateHandler } from "./gates/pr-ready-handler.ts";
import type { PlanCommentReader } from "./gates/plan-comment.ts";
import { loadVerifyConfig, verifyConfigPath } from "./gates/verify-config.ts";
import { join } from "node:path";
import { ghGitHub, type EpicGateway, resolveAgentLogin as ghResolveAgentLogin } from "./github.ts";
import { appendQuestion, makeRoutingEpicGateway } from "./epic-store/index.ts";
import { readEpicStoreConfig } from "./repo-config.ts";
import type { SessionGate } from "./hook-server.ts";
import { AGENT_COMMENT_MARKER } from "./poller.ts";
import { killSession, newSession, sendEnter, sendText, status } from "./tmux.ts";
import { findActiveWorkflowBySession, getWorkflow } from "./workflow-record.ts";
import type { ImplementationDeps, ImplementationInput } from "./workflows/implementation.ts";
import { createWorktree, destroyWorktree } from "./worktree.ts";

/** The slice of {@link EpicGateway} the deps factory reads. */
type DepsGitHub = Pick<
  EpicGateway,
  "findEpicPr" | "getCommentAuthor" | "postComment" | "getIssueLabels" | "listIssueComments"
>;

/** The label a human applies to an Epic to authorize proceeding past a complexity pause. */
const APPROVED_LABEL = "approved";

/**
 * Format the pause comment the dispatcher posts on the Epic when an agent parks.
 * A `"complexity"` pause is framed with the literal **complexity pause** label so
 * the recommender (reading the Epic) classifies it under the state issue's
 * `complexity pause` needs-human label; a plain question reads as an agent
 * question. The recommender owns "Needs human input", so this comment is the
 * GitHub trace it keys off (the dispatcher never writes that section directly).
 *
 * Every output **starts with** the hidden {@link AGENT_COMMENT_MARKER} so the
 * poller's `classifyNewHumanReply` skips it: the dispatcher posts under its own
 * (human, non-bot) `gh` identity, and without the marker the poller would read
 * this very comment as "the human reply" and fire a spurious self-resume.
 */
export function formatPauseComment(opts: {
  question: string;
  context?: string;
  kind: "question" | "complexity";
}): string {
  const body = opts.context ? `> ${opts.question}\n\n${opts.context}` : `> ${opts.question}`;
  if (opts.kind === "complexity") {
    return `${AGENT_COMMENT_MARKER}
🧩 **complexity pause** — the agent paused a sub-issue whose decision needs more candidate forks than this repo's \`complexity_ceiling\`.

${body}

A human resolves this by **scope reduction or clarification** — or applies the \`${APPROVED_LABEL}\` label to authorize a best-judgment call within the ceiling on resume.`;
  }
  return `${AGENT_COMMENT_MARKER}
🙋 **agent question** — the dispatched agent needs input to proceed.

${body}`;
}

/**
 * Post the agent-pause comment on the Epic **idempotently** (the #205 spam fix).
 *
 * Lists the Epic's comments, finds the *most recent* agent-comment (the
 * {@link AGENT_COMMENT_MARKER} prefix every {@link formatPauseComment} carries),
 * and decides:
 *  - its body already equals `body` → **no-op** (`"skipped"`): the same question
 *    is already the open thread, so a repeated park (the recommender re-dispatches
 *    a stuck Epic every cron tick) must not append a duplicate — this is what
 *    collapsed #177's 1137 identical comments to one;
 *  - otherwise → **post a fresh comment** (`"posted"`): a *different* question is
 *    a new entry in the question history, and we never edit the prior one away
 *    (acceptance criterion 1 — "questions are a history").
 *
 * Comments arrive chronological (oldest→newest, per `ghGitHub.listIssueComments`),
 * so the last marker-prefixed comment is the most recent agent-comment. The full
 * rendered `body` is compared (not just the question text) so a complexity pause
 * and a plain question with the same text correctly read as distinct.
 */
export async function postQuestionComment(opts: {
  github: Pick<EpicGateway, "listIssueComments" | "postComment">;
  repo: string;
  epicRef: string;
  body: string;
}): Promise<"posted" | "skipped"> {
  const comments = await opts.github.listIssueComments(opts.repo, opts.epicRef);
  let latestAgentBody: string | undefined;
  for (const c of comments) {
    if (c.body.startsWith(AGENT_COMMENT_MARKER)) latestAgentBody = c.body;
  }
  if (latestAgentBody !== undefined && latestAgentBody.trim() === opts.body.trim()) {
    return "skipped";
  }
  await opts.github.postComment(opts.repo, opts.epicRef, opts.body);
  return "posted";
}

/**
 * Build the default `postQuestion` surface — the agent-pause poster the
 * implementation workflow calls when it parks. file-mode repos append a
 * `<!-- middle:question -->` block to the Epic file (idempotent per
 * {@link appendQuestion}); github-mode repos comment on the Epic idempotently via
 * {@link postQuestionComment}. Extracted so the production path and the
 * integration test share one implementation (no re-implemented poster).
 */
export function makeDefaultPostQuestion(deps: {
  db: Database;
  resolveRepoPath: (repo: string) => string;
  github: Pick<EpicGateway, "listIssueComments" | "postComment">;
}): NonNullable<ImplementationDeps["postQuestion"]> {
  return async ({ repo, epicRef, question, context, kind }) => {
    const cfg = readEpicStoreConfig(deps.db, repo);
    if (cfg.mode === "file") {
      appendQuestion(join(deps.resolveRepoPath(repo), cfg.epicsDir), epicRef, {
        question,
        context,
        kind,
      });
    } else {
      await postQuestionComment({
        github: deps.github,
        repo,
        epicRef,
        body: formatPauseComment({ question, context, kind }),
      });
    }
  };
}

/** Render the failed gates of a run into the nudge the agent reads (name + why + tail of output). */
function formatGateFailures(report: GateRunReport): string {
  return report.results
    .filter((r) => !r.passed)
    .map((r) => {
      const why = r.timedOut ? "timed out" : `exit ${r.exitCode ?? "killed"}`;
      const out = (r.stderr.trim() || r.stdout.trim() || "(no output)").slice(-1500);
      return `### gate \`${r.name}\` failed (${why})\n$ ${r.command}\n${out}`;
    })
    .join("\n\n");
}

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
  /**
   * Surface the agent's pause on the Epic when it parks. Defaults to a
   * `gh`-backed comment poster ({@link formatPauseComment}); injectable for tests.
   */
  postQuestion?: ImplementationDeps["postQuestion"];
  /** Resolve a repo's `complexity_ceiling` for the dispatch brief; defaults to 3 when omitted. */
  resolveComplexityCeiling?: ImplementationDeps["resolveComplexityCeiling"];
  /** Whether an Epic carries the `approved` label (#53); defaults to not-approved when omitted. */
  isEpicApproved?: ImplementationDeps["isEpicApproved"];
  launchTimeoutMs?: number;
  stopTimeoutMs?: number;
  livenessPollMs?: number;
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
  // The daemon registers one workflow with one deps, but Epic-store mode is
  // per-repo — so the default gateway is a router that delegates each call to the
  // repo's file or gh backend (keyed on the method's `repo` arg). An injected
  // `args.github` (tests) overrides it. github-mode repos route to `ghGitHub`, so
  // behavior is identical when no repo opts into file mode.
  const routingGh = makeRoutingEpicGateway({
    db: args.db,
    resolveRepoPath: args.resolveRepoPath,
    ghEpic: ghGitHub,
  });
  const github = args.github ?? routingGh;
  const resolveLogin = args.resolveAgentLogin ?? ghResolveAgentLogin;

  // The PR-ready gate resolves a session to its Epic via the workflow row, then
  // reads the Epic PR through `gh`.
  const prReadyGate = makePrReadyGateHandler({
    resolveSession: (sessionName) => {
      const active = findActiveWorkflowBySession(args.db, sessionName);
      if (!active) return null;
      const workflow = getWorkflow(args.db, active.id);
      if (!workflow || workflow.epicRef === null) return null;
      return { repo: workflow.repo, epicRef: workflow.epicRef };
    },
    findEpicPr: (repo, epicRef) => github.findEpicPr(repo, epicRef),
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
    tmux: { newSession, sendText, sendEnter, killSession, status },
    worktree: { createWorktree, destroyWorktree },
    resolveRepoPath: args.resolveRepoPath,
    worktreeRoot: args.worktreeRoot,
    dispatcherUrl,
    enqueueContinuation: args.enqueueContinuation,
    planCommentReader: args.planCommentReader ?? routingGh,
    agentLogin,
    // Positive done-signal (#80): a bare-stop only completes if the Epic
    // already has a ready, non-draft PR.
    epicPrReadiness: async (repo, epicRef) => {
      const pr = await github.findEpicPr(repo, epicRef);
      return { exists: pr !== null, isDraft: pr?.isDraft ?? false };
    },
    // Default surface: comment the pause on the Epic (framed by kind) via `gh`,
    // so the recommender can classify a complexity pause under `complexity pause`.
    // Idempotent on a repeated park (#205) — see `makeDefaultPostQuestion`.
    postQuestion:
      args.postQuestion ??
      makeDefaultPostQuestion({ db: args.db, resolveRepoPath: args.resolveRepoPath, github }),
    resolveComplexityCeiling: args.resolveComplexityCeiling,
    // The repo's Epic-store mode selects which mode-commands reference the brief
    // mirrors into the worktree; read from `repo_config` (defaults to github).
    resolveEpicStoreMode: (repo) => readEpicStoreConfig(args.db, repo).mode,
    // Default: the Epic is approved iff it carries the `approved` label (#53).
    isEpicApproved:
      args.isEpicApproved ??
      (async (repo, epicRef) =>
        (await github.getIssueLabels(repo, epicRef)).includes(APPROVED_LABEL)),
    launchTimeoutMs: args.launchTimeoutMs,
    stopTimeoutMs: args.stopTimeoutMs,
    livenessPollMs: args.livenessPollMs,
    reviewRoundCap: args.reviewRoundCap,
    maxNudges: args.maxNudges,
    nudgeStopTimeoutMs: args.nudgeStopTimeoutMs,
    // Verify-on-stop: run the worktree's verify.toml gates when the agent claims
    // `done`. A missing/malformed verify.toml → skip (ok), so the enforcement is
    // opt-in per repo (middle's own repo has one).
    runVerifyGates: async (worktree: string) => {
      let gates;
      try {
        gates = loadVerifyConfig(verifyConfigPath(worktree)).gates;
      } catch (error) {
        console.error(
          `[verify-on-stop] no usable verify.toml in ${worktree} — skipping: ${(error as Error).message}`,
        );
        return { ok: true, report: "" };
      }
      const report = await runGates(gates, { cwd: worktree });
      return { ok: report.ok, report: report.ok ? "" : formatGateFailures(report) };
    },
  };

  return { deps, prReadyGate };
}
