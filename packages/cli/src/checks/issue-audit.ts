/**
 * Issue requirements audit (Epic #143, sub-issue #144). Evaluates issue bodies
 * against the shared integration rubric from `@middle/core` and reports, per
 * feature issue, whether it carries an integration criterion — plus a concrete
 * suggested rewrite when it doesn't.
 *
 * Pure over fetched data: the gh I/O lives in the `mm audit-issues` command so
 * this module is testable without a network. The rubric predicate itself lives
 * in `@middle/core` so the standing audit here and the PR-ready gate in the
 * dispatcher enforce the *same* contract.
 */
import {
  auditIssueBody,
  isFeatureIssue as labelsAreFeature,
  type RubricFinding,
} from "@middle/core";

/** The minimal shape of an issue the audit needs (filled from `gh ... --json`). */
export type IssueLike = {
  number: number;
  title: string;
  body: string;
  labels: string[];
};

/** Per-issue audit result: the rubric finding plus the issue's identity. */
export type IssueAuditReport = {
  number: number;
  title: string;
  finding: RubricFinding;
};

/** Whether the rubric applies to this issue (delegates to the shared core policy). */
export function isFeatureIssue(issue: IssueLike): boolean {
  return labelsAreFeature(issue.labels);
}

/** Audit one issue against the integration rubric (regardless of feature class). */
export function auditIssue(issue: IssueLike): IssueAuditReport {
  return {
    number: issue.number,
    title: issue.title,
    finding: auditIssueBody(issue.body, { title: issue.title }),
  };
}

/** Audit a batch, keeping only feature issues. Order is preserved. */
export function auditIssues(issues: IssueLike[]): IssueAuditReport[] {
  return issues.filter(isFeatureIssue).map(auditIssue);
}

/** Render one audit report as human-readable lines for the CLI. */
export function formatReport(report: IssueAuditReport): string {
  const head =
    report.number > 0 ? `#${report.number} ${report.title}` : report.title || "(draft body)";
  if (report.finding.pass) {
    const why = report.finding.exempt
      ? `integration-exempt: ${report.finding.exemptReason ?? ""}`
      : `${report.finding.integrationCriteria.length} integration criterion/criteria`;
    return `✓ PASS  ${head} — ${why}`;
  }
  return [
    `✗ FAIL  ${head} — no integration criterion`,
    indent(report.finding.suggestion ?? ""),
  ].join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `        ${l}`)
    .join("\n");
}
