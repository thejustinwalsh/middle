/**
 * Standing backlog audit (Epic #143, sub-issue #144) — the recommender-sibling
 * pass that sweeps a repo's open issues and labels the ones whose acceptance
 * criteria fail the integration rubric `needs-design`, until they're hardened.
 *
 * It enforces the *same* contract as `mm audit-issues` and the PR-ready gate, via
 * the shared predicate in `@middle/core`. The pass is proposal-first: it labels
 * (a visible, reversible flag) and never edits an issue body.
 */
import { auditIssueBody, isFeatureIssue } from "@middle/core";
import type { GitHubGateway } from "./github.ts";

/** The `needs-design` label applied to issues that fail the integration rubric. */
export const NEEDS_DESIGN_LABEL = "needs-design";

/** Default cap on issues flagged in a single pass, so one sweep can't label-storm. */
const DEFAULT_MAX_FLAGS_PER_PASS = 25;

/** Dependency contract for {@link runBacklogAudit} — the repo to sweep, the GitHub gateway it reads/labels through, and the per-pass flag cap. */
export type BacklogAuditDeps = {
  /** The `owner/name` repo slug whose open feature issues are audited. */
  repo: string;
  github: Pick<GitHubGateway, "listOpenIssues" | "addLabel">;
  /** Cap on issues labelled per pass (default {@link DEFAULT_MAX_FLAGS_PER_PASS}). */
  maxFlagsPerPass?: number;
};

/**
 * Audit every open **feature** issue in a repo against the integration rubric.
 * Issues that fail and don't already carry `needs-design` get labelled (capped
 * per pass). Returns the issue numbers newly flagged. Per-issue label failures
 * are isolated so one bad write doesn't abort the sweep.
 */
export async function runBacklogAudit(deps: BacklogAuditDeps): Promise<{ flagged: number[] }> {
  const cap = deps.maxFlagsPerPass ?? DEFAULT_MAX_FLAGS_PER_PASS;
  const issues = await deps.github.listOpenIssues(deps.repo);
  const flagged: number[] = [];
  for (const issue of issues) {
    if (flagged.length >= cap) break;
    if (!isFeatureIssue(issue.labels)) continue;
    if (issue.labels.some((l) => l.toLowerCase() === NEEDS_DESIGN_LABEL)) continue; // already flagged
    const finding = auditIssueBody(issue.body, { title: issue.title });
    if (finding.pass) continue;
    try {
      await deps.github.addLabel(deps.repo, issue.number, NEEDS_DESIGN_LABEL);
      flagged.push(issue.number);
      console.error(
        `[backlog-audit] ${deps.repo}#${issue.number} fails the integration rubric → ${NEEDS_DESIGN_LABEL}`,
      );
    } catch (error) {
      console.error(
        `[backlog-audit] failed to label ${deps.repo}#${issue.number} (continuing): ${(error as Error).message}`,
      );
    }
  }
  return { flagged };
}
