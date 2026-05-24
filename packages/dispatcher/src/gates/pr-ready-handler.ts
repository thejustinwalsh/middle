/**
 * The server side of the PR-ready guard: given the session a `gh pr ready` hook
 * fired from, resolve the Epic PR and decide whether the command may proceed.
 *
 * Built as a factory over injected seams (session resolution + GitHub reads) so
 * the orchestration is unit-testable without a live db or `gh`. The dispatcher
 * binds the real seams (workflow row → repo/epic, `ghGitHub`) when it wires the
 * `/gates/pr-ready` endpoint.
 */
import type { HookPayload } from "@middle/core";
import {
  type CommentAuthorResolver,
  commandIsPrReady,
  evaluatePrReady,
  extractCommand,
  type PrReadyDecision,
} from "./pr-ready.ts";

export type PrReadyGateDeps = {
  /** Map a session name to its workflow's repo + Epic number, or null. */
  resolveSession: (sessionName: string) => { repo: string; epicNumber: number } | null;
  /** The open Epic PR (its body carries the union of sub-issue criteria), or null. */
  findEpicPr: (repo: string, epicNumber: number) => Promise<{ body: string } | null>;
  /** Resolve a deferral comment's author (for the non-bot check). */
  resolveCommentAuthor: CommentAuthorResolver;
};

export type PrReadyGateHandler = (opts: {
  sessionName: string;
  payload: HookPayload;
}) => Promise<PrReadyDecision>;

export function makePrReadyGateHandler(deps: PrReadyGateDeps): PrReadyGateHandler {
  return async ({ sessionName, payload }) => {
    // The hook fires on every Bash PreToolUse; only `gh pr ready` is gated.
    const command = extractCommand(payload);
    if (command === null || !commandIsPrReady(command)) return { decision: "allow" };

    const workflow = deps.resolveSession(sessionName);
    if (!workflow) {
      return {
        decision: "deny",
        reason: `PR-ready guard: no active workflow owns session "${sessionName}".`,
      };
    }

    const pr = await deps.findEpicPr(workflow.repo, workflow.epicNumber);
    if (!pr) {
      return {
        decision: "deny",
        reason: `PR-ready guard: no open Epic PR found for #${workflow.epicNumber}.`,
      };
    }

    return evaluatePrReady({ body: pr.body, resolveCommentAuthor: deps.resolveCommentAuthor });
  };
}
