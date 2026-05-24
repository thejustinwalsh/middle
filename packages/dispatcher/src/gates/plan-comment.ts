/**
 * Plan-comment guard (skill enforcement gate #1).
 *
 * After the agent finishes its plan phase, the dispatcher confirms the plan was
 * actually posted as a comment on the Epic — making the implementer skill's
 * "post the plan as a comment" step a hard gate rather than a suggestion. The
 * plan covers the whole Epic (every sub-issue as a phase), so a single matching
 * comment on the Epic satisfies the gate.
 */

/** One issue comment, narrowed to the fields the guard needs. */
export type IssueComment = {
  authorLogin: string;
  body: string;
  url: string;
};

/** The GitHub read seam this gate depends on (satisfied by the gh-CLI gateway). */
export interface PlanCommentReader {
  listIssueComments(repo: string, issueNumber: number): Promise<IssueComment[]>;
}

export type GateResult = { ok: true } | { ok: false; reason: string };

/**
 * Normalize a body for comparison: CRLF → LF, and trim leading/trailing
 * whitespace. The plan is posted verbatim via `gh issue comment --body-file`,
 * so the only differences we expect are line-ending and edge-whitespace
 * normalization; the substring match below absorbs an optional preamble the
 * agent may add above the plan.
 */
function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export async function verifyPlanComment(opts: {
  gh: PlanCommentReader;
  repo: string;
  epicNumber: number;
  planBody: string;
  /** When set, only comments by this account count (the agent's gh identity). */
  agentLogin?: string;
}): Promise<GateResult> {
  const miss: GateResult = {
    ok: false,
    reason: `Plan-comment guard: no plan comment found on Epic #${opts.epicNumber}`,
  };

  const needle = normalize(opts.planBody);
  // An empty/whitespace-only plan must never vacuously match — every comment
  // body trivially "contains" the empty string.
  if (needle === "") return miss;

  const comments = await opts.gh.listIssueComments(opts.repo, opts.epicNumber);
  for (const comment of comments) {
    if (opts.agentLogin !== undefined && comment.authorLogin !== opts.agentLogin) continue;
    if (normalize(comment.body).includes(needle)) return { ok: true };
  }
  return miss;
}
