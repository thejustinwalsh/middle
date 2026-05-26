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
 * On top of that per-criterion check, the **integration-verified definition of
 * done** (Epic #143, sub-issue #145) requires the PR to evidence ≥1 *integration
 * criterion* — one that wires the feature into the running product and is proven
 * by a named integration/smoke/e2e test (the shared rubric in `@middle/core`).
 * A unit-green-but-unwired feature can't reach ready. The escape hatch is an
 * explicit, human-authored `(integration-exempt: <comment-url>)` annotation.
 *
 * The shell hook stays dumb: this module owns the matching and the evaluation,
 * so the gate's logic is unit-testable without a live agent or GitHub.
 */
import { isIntegrationCriterion, parseAcceptanceCriteria } from "@middle/core";

export { parseAcceptanceCriteria };

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

export type CommentAuthor = { login: string; isBot: boolean };
export type CommentAuthorResolver = (commentUrl: string) => Promise<CommentAuthor | null>;

const DEFERRED_RE = /\(deferred:\s*(\S+?)\s*\)/i;
/** The integration escape hatch — mirrors `(deferred: …)`; must be human-authored. */
const INTEGRATION_EXEMPT_RE = /\(integration-exempt:\s*(\S+?)\s*\)/i;
/** An evidence link: an http(s) URL or a GitHub `#<number>` issue/PR reference. */
const EVIDENCE_RE = /(https?:\/\/\S+|#\d+)/;
/** A named test artifact: a `*.test.ts` / `*.spec.tsx` (etc.) file path. */
const TEST_FILE_RE = /\b[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?\b/;

/** Whether a criterion carries concrete evidence — a link/`#ref` or a named test file. */
function namesEvidence(criterion: string): boolean {
  return EVIDENCE_RE.test(criterion) || TEST_FILE_RE.test(criterion);
}

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
    if (namesEvidence(criterion)) continue; // has evidence (link/#ref or a named test file)
    unmet.push(criterion);
  }

  if (unmet.length > 0) {
    return {
      decision: "deny",
      reason: [
        "PR-ready guard: these acceptance criteria lack an evidence link or a",
        "stakeholder-authorized `(deferred: <comment-url>)` annotation:",
        ...unmet.map((c) => `  - ${c}`),
      ].join("\n"),
    };
  }

  // Integration-verified definition of done (#145): the PR must evidence ≥1
  // integration criterion (proven by a named test), or carry a human-authored
  // exemption — otherwise a unit-green-but-unwired feature could reach ready.
  return evaluateIntegrationEvidence(opts.body, criteria, opts.resolveCommentAuthor);
}

/**
 * The integration half of the gate. Satisfied when the body declares a
 * human-authored `(integration-exempt: <comment-url>)` annotation, or when ≥1
 * acceptance criterion is an integration criterion that carries concrete,
 * non-deferred evidence (a link/`#ref` or a named test file). Otherwise denies.
 */
async function evaluateIntegrationEvidence(
  body: string,
  criteria: string[],
  resolveCommentAuthor: CommentAuthorResolver,
): Promise<PrReadyDecision> {
  const exempt = INTEGRATION_EXEMPT_RE.exec(body);
  if (exempt) {
    const author = await resolveCommentAuthor(exempt[1]!);
    if (author && !author.isBot) return { decision: "allow" }; // human-authorized exemption
    return {
      decision: "deny",
      reason: [
        "PR-ready guard: the `(integration-exempt: …)` annotation must point at a",
        "comment by a non-bot human; an agent can't author its own exemption.",
      ].join("\n"),
    };
  }

  const evidenced = criteria.some(
    (c) => isIntegrationCriterion(c) && namesEvidence(c) && !DEFERRED_RE.test(c),
  );
  if (evidenced) return { decision: "allow" };

  return {
    decision: "deny",
    reason: [
      "PR-ready guard: no acceptance criterion evidences an integration test. A",
      "feature must wire into the running product (mounted/served/invoked) and be",
      "proven by a named integration/smoke/e2e test — `unit tests pass` is not enough.",
      "Add an evidenced integration criterion, or a human-authored",
      "`(integration-exempt: <comment-url>)` annotation if integration is infeasible.",
    ].join("\n"),
  };
}
