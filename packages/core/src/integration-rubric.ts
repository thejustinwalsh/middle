/**
 * Integration rubric — the shared predicate behind the self-auditing systems
 * (Epic #143). Both the requirements auditor (`mm audit-issues`, sub-issue #144)
 * and the PR-ready gate (sub-issue #145) consume this, so the contract enforced
 * when an issue is *filed* is identical to the one enforced when work *lands*.
 *
 * The rubric: a feature issue must carry ≥1 acceptance criterion that is an
 * **integration criterion** — one that both (i) wires the feature into the
 * running product (mounted / served / invoked / reachable — not merely
 * *exported*) and (ii) is proven by an integration / smoke / e2e test that
 * exercises that real path. "Unit tests pass" alone is insufficient.
 *
 * This module owns only the *declaration* of the rubric (string predicates). It
 * deliberately does not decide *authorization* of an exemption — the PR-ready
 * gate validates that a declared exemption is human-authored; here we only
 * detect that the declaration is present.
 */

/**
 * Extract acceptance criteria: the list items under the first heading whose text
 * contains "acceptance". Collection stops at the next heading. Both checkbox
 * (`- [ ] …` / `- [x] …`) and plain (`- …`) list items count; the checkbox state
 * is irrelevant. This is the single source of truth for criteria extraction —
 * the PR-ready gate imports it so filing-time and landing-time agree.
 */
export function parseAcceptanceCriteria(body: string): string[] {
  const lines = body.split("\n");
  const criteria: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      // Collection is the *first* acceptance section only: once we've entered
      // it, the next heading of any level ends collection for good — a later
      // "## Acceptance …" heading must not reopen it (which would silently fold
      // a second, unintended list into the criteria and change gate outcomes).
      if (inSection) break;
      inSection = /acceptance/i.test(line);
      continue;
    }
    if (!inSection) continue;
    const item = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$/.exec(line);
    if (item) criteria.push(item[1]!);
  }
  return criteria;
}

/**
 * Signals that a criterion wires the feature into the running product — it is
 * reachable/used, not merely exported. HTTP verbs are matched case-sensitively
 * (uppercase) so prose like "get the value" doesn't trip them.
 */
const WIRING_RE =
  /\b(?:serves?|serving|served|mounts?|mounted|mounting|invoke[ds]?|invoking|reachable|wired|registers?|registered|dispatch(?:es|ed)?|boots?|booted|booting|launch(?:es|ed)?|endpoints?|routes?|running product|real product|the daemon|the cli|the spa|end-to-end)\b|\b(?:GET|POST|PUT|PATCH|DELETE)s?\b|\bmm\s+[a-z-]+/;

/**
 * Signals that a criterion is proven by a real-path test — an integration,
 * smoke, or e2e test that exercises the live path, not a unit stub. The bare
 * phrase "unit test(s) pass" matches nothing here, so it can never satisfy the
 * rubric on its own.
 */
const REAL_PATH_TEST_RE =
  /\b(?:integration[ -]?tests?|smoke[ -]?tests?|e2e|end-to-end|exercis(?:e|es|ing)|boots? the|drives? the|runs? the real|real path|live (?:path|frame|server))\b/i;

/**
 * Whether a single acceptance-criterion string is an *integration criterion*: it
 * names a product-wiring signal **and** a real-path-test signal. This is the
 * atom both #144 and #145 build on.
 */
export function isIntegrationCriterion(text: string): boolean {
  return WIRING_RE.test(text) && REAL_PATH_TEST_RE.test(text);
}

/**
 * Labels that take an issue out of the rubric's scope — it isn't a product
 * feature that wires into the running app. Epics are umbrellas (their
 * *sub-issues* carry the integration criterion); docs/chore/housekeeping aren't
 * features; the rest are already-triaged exclusion states.
 */
export const NON_FEATURE_LABELS: readonly string[] = [
  "epic",
  "housekeeping",
  "documentation",
  "docs",
  "chore",
  "question",
  "wontfix",
  "duplicate",
  "invalid",
  "blocked",
];

/** Whether the integration rubric applies to an issue with these labels. */
export function isFeatureIssue(labels: string[]): boolean {
  const skip = new Set(NON_FEATURE_LABELS);
  return !labels.some((l) => skip.has(l.toLowerCase()));
}

/** Matches an explicit, intentional exemption declared in an issue/PR body. */
const EXEMPTION_RE = /integration-exempt:\s*(.+?)\s*(?:-->|\)|$)/im;

/**
 * Detect a declared integration exemption (the rubric escape hatch). Returns the
 * stated reason, or null if none. Recognises a body line / HTML comment / inline
 * annotation of the form `integration-exempt: <reason-or-url>`. Detection only —
 * callers that need *authorization* (a human author) check that separately.
 */
export function detectExemption(body: string): string | null {
  const m = EXEMPTION_RE.exec(body);
  return m ? m[1]!.trim() : null;
}

/** The outcome of auditing one issue body against the integration rubric. */
export type RubricFinding = {
  /** True when the body carries an integration criterion or a declared exemption. */
  pass: boolean;
  /** Every acceptance criterion found in the body. */
  criteria: string[];
  /** The subset of `criteria` that qualify as integration criteria. */
  integrationCriteria: string[];
  /** True when the body declares an explicit integration exemption. */
  exempt: boolean;
  /** The stated exemption reason, when `exempt`. */
  exemptReason?: string;
  /** A concrete suggested rewrite, present only when `pass` is false. */
  suggestion?: string;
};

/**
 * Audit an issue body against the integration rubric. Passes when the body has
 * ≥1 integration criterion or a declared exemption; otherwise fails with a
 * concrete suggested rewrite naming the missing criterion. Pure: no I/O, no
 * knowledge of whether the issue is a "feature" — callers classify that.
 */
export function auditIssueBody(body: string, opts: { title?: string } = {}): RubricFinding {
  const criteria = parseAcceptanceCriteria(body);
  const integrationCriteria = criteria.filter(isIntegrationCriterion);
  const exemptReason = detectExemption(body);
  const exempt = exemptReason !== null;

  if (exempt) {
    return { pass: true, criteria, integrationCriteria, exempt: true, exemptReason };
  }
  if (integrationCriteria.length > 0) {
    return { pass: true, criteria, integrationCriteria, exempt: false };
  }
  return {
    pass: false,
    criteria,
    integrationCriteria,
    exempt: false,
    suggestion: suggestRewrite(opts.title, criteria.length === 0),
  };
}

/** A concrete suggested integration criterion, anchored to the feature's title. */
function suggestRewrite(title: string | undefined, noCriteria: boolean): string {
  const feature = title?.trim() ? `"${title.trim()}"` : "this feature";
  const lead = noCriteria
    ? `No acceptance criteria found. Add an "Acceptance criteria" section, and include`
    : `No acceptance criterion wires ${feature} into the running product and proves it with a real-path test. Add`;
  return [
    `${lead} at least one integration criterion. For ${feature}, phrase it like:`,
    "  - `mm <command>` serves/invokes/mounts the feature in the running product; an",
    "    integration or smoke test boots the real path (e.g. the daemon or the CLI) and",
    "    asserts an observable behavior — not merely that a unit returns a value.",
    'Example: "`mm start` serves the dashboard at `/`; a smoke test boots the daemon and',
    'GETs `/`, asserting the SPA shell renders".',
  ].join("\n");
}
