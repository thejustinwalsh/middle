/**
 * Gate evidence posting (Phase 6, build-spec item #32).
 *
 * Renders a phase's {@link GateRunReport} into a PR comment — a pass/fail summary
 * table plus collapsed `<details>` blocks with each gate's full output — and
 * upserts it. Each phase's evidence is keyed by an HTML marker so re-runs update
 * the same comment in place rather than spamming duplicates.
 */
import type { GateResult, GateRunReport } from "./gate-runner.ts";
import type { IssueComment } from "./plan-comment.ts";

/** The GitHub seam evidence posting needs (a subset of `GitHubGateway`). */
export interface EvidenceGateway {
  listIssueComments(repo: string, issueNumber: number): Promise<IssueComment[]>;
  postComment(repo: string, issueNumber: number, body: string): Promise<void>;
  editComment(repo: string, commentId: number, body: string): Promise<void>;
}

/** The hidden marker that identifies a phase's evidence comment for in-place updates. */
export function evidenceMarker(subIssue: number): string {
  return `<!-- middle:gate-evidence:phase-${subIssue} -->`;
}

function statusLabel(r: GateResult): string {
  if (r.timedOut) return "⏱️ timed out";
  if (r.passed) return "✅ pass";
  return `❌ fail (exit ${r.exitCode ?? "killed"})`;
}

/** A code fence longer than the longest backtick run in `content` (min 3). */
function fenceFor(content: string): string {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

function detailsBlock(r: GateResult): string {
  const parts: string[] = [];
  if (r.stdout.trim() !== "") parts.push(`$ ${r.command}\n${r.stdout}`);
  if (r.stderr.trim() !== "") parts.push(`[stderr]\n${r.stderr}`);
  if (parts.length === 0) parts.push(r.timedOut ? "(no output before timeout)" : "(no output)");
  const body = parts.join("\n");
  const fence = fenceFor(body);
  return [
    `<details><summary>${r.name} — ${statusLabel(r)} (${(r.durationMs / 1000).toFixed(1)}s)</summary>`,
    "",
    `${fence}\n${body}\n${fence}`,
    "</details>",
  ].join("\n");
}

/** Render a phase's gate report into a Markdown evidence comment. */
export function renderEvidence(subIssue: number, report: GateRunReport): string {
  const header = report.ok
    ? `✅ **All ${report.results.length} verification gate(s) passed** for phase #${subIssue}.`
    : `❌ **Verification gates failed** for phase #${subIssue} (first failure: \`${report.failedGate}\`).`;

  const table = [
    "| Gate | Result | Duration |",
    "| --- | --- | --- |",
    ...report.results.map((r) => `| ${r.name} | ${statusLabel(r)} | ${(r.durationMs / 1000).toFixed(1)}s |`),
  ].join("\n");

  const details = report.results.map(detailsBlock).join("\n\n");

  return [
    evidenceMarker(subIssue),
    `## Verification gates — phase #${subIssue}`,
    "",
    header,
    "",
    table,
    ...(details ? ["", details] : []),
    "",
  ].join("\n");
}

/** Parse the issue-comment id from a comment URL (`…#issuecomment-123`); null if absent. */
function commentId(url: string): number | null {
  const m = /#issuecomment-(\d+)/.exec(url);
  return m ? Number(m[1]) : null;
}

/**
 * Post (or update in place) the evidence comment for `subIssue` on the PR. Finds
 * an existing comment carrying this phase's marker and edits it; otherwise posts
 * a fresh one — so re-runs never accumulate duplicate comments.
 */
export async function upsertEvidenceComment(opts: {
  gh: EvidenceGateway;
  repo: string;
  prNumber: number;
  subIssue: number;
  report: GateRunReport;
}): Promise<void> {
  const marker = evidenceMarker(opts.subIssue);
  const body = renderEvidence(opts.subIssue, opts.report);

  const comments = await opts.gh.listIssueComments(opts.repo, opts.prNumber);
  const existing = comments.find((c) => c.body.includes(marker));
  const id = existing ? commentId(existing.url) : null;

  if (existing && id !== null) {
    await opts.gh.editComment(opts.repo, id, body);
  } else {
    await opts.gh.postComment(opts.repo, opts.prNumber, body);
  }
}
