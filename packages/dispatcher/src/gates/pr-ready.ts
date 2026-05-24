/**
 * PR-ready guard (skill enforcement gate #2).
 *
 * Phase 10 of the implementer skill (the acceptance gate) becomes mechanically
 * enforced. A `PreToolUse` hook matches `gh pr ready` and calls the dispatcher's
 * `/gates/pr-ready` endpoint; the dispatcher walks the Epic PR's acceptance
 * criteria — the union of every sub-issue's criteria, all rendered into the one
 * Epic PR body — and requires each to carry **either** an evidence link **or** a
 * `(deferred: <comment-url>)` annotation whose comment is by a non-bot user.
 *
 * The shell hook stays dumb: this module owns the matching and the evaluation,
 * so the gate's logic is unit-testable without a live agent or GitHub.
 */

/** Pull the Bash command out of a PreToolUse payload, or null if absent. */
export function extractCommand(payload: Record<string, unknown>): string | null {
  const toolInput = payload.tool_input as { command?: unknown } | undefined;
  const command = toolInput?.command;
  return typeof command === "string" ? command : null;
}

/** Whether a command is a `gh pr ready` invocation (substring match per spec). */
export function commandIsPrReady(command: string): boolean {
  return /\bgh\s+pr\s+ready\b/.test(command);
}

/**
 * Extract the acceptance criteria — the list items under the first heading whose
 * text contains "acceptance". Collection stops at the next heading. Both
 * checkbox (`- [ ] …` / `- [x] …`) and plain (`- …`) list items count; the
 * checkbox state is irrelevant — evidence, not the tick, is what the gate checks.
 */
export function parseAcceptanceCriteria(body: string): string[] {
  const lines = body.split("\n");
  const criteria: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      inSection = /acceptance/i.test(line);
      continue;
    }
    if (!inSection) continue;
    const item = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$/.exec(line);
    if (item) criteria.push(item[1]!);
  }
  return criteria;
}

export type CommentAuthor = { login: string; isBot: boolean };
export type CommentAuthorResolver = (commentUrl: string) => Promise<CommentAuthor | null>;

const DEFERRED_RE = /\(deferred:\s*(\S+?)\s*\)/i;
/** An evidence link: an http(s) URL or a GitHub `#<number>` issue/PR reference. */
const EVIDENCE_RE = /(https?:\/\/\S+|#\d+)/;

export type PrReadyDecision = { decision: "allow" } | { decision: "deny"; reason: string };

/**
 * Walk the PR body's acceptance criteria and decide whether `gh pr ready` may
 * proceed. A criterion passes if it carries a `(deferred: <url>)` annotation
 * whose comment is by a non-bot user, OR (absent a deferral) an evidence link.
 * An empty criteria section denies — so the gate can't be bypassed by deleting
 * the section.
 */
export async function evaluatePrReady(opts: {
  body: string;
  resolveCommentAuthor: CommentAuthorResolver;
}): Promise<PrReadyDecision> {
  const criteria = parseAcceptanceCriteria(opts.body);
  if (criteria.length === 0) {
    return {
      decision: "deny",
      reason: "PR-ready guard: no acceptance criteria found in the PR body.",
    };
  }

  const unmet: string[] = [];
  for (const criterion of criteria) {
    const deferred = DEFERRED_RE.exec(criterion);
    if (deferred) {
      const author = await opts.resolveCommentAuthor(deferred[1]!);
      if (author && !author.isBot) continue; // stakeholder-authorized deferral
      unmet.push(criterion);
      continue;
    }
    if (EVIDENCE_RE.test(criterion)) continue; // has evidence
    unmet.push(criterion);
  }

  if (unmet.length === 0) return { decision: "allow" };
  return {
    decision: "deny",
    reason: [
      "PR-ready guard: these acceptance criteria lack an evidence link or a",
      "stakeholder-authorized `(deferred: <comment-url>)` annotation:",
      ...unmet.map((c) => `  - ${c}`),
    ].join("\n"),
  };
}
