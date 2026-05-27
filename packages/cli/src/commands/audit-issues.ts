import { readFile } from "node:fs/promises";
import { auditIssueBody } from "@middle/core";
import {
  auditIssue,
  auditIssues,
  formatReport,
  type IssueAuditReport,
  type IssueLike,
} from "../checks/issue-audit.ts";

/** The `needs-design` label applied to issues that fail the integration rubric. */
export const NEEDS_DESIGN_LABEL = "needs-design";

/**
 * Options for {@link runAuditIssues} — the `mm audit-issues` command. Selects the
 * mode (single issue / local body file / standing backlog), toggles JSON output
 * and label application, and lets every GitHub/fs interaction be injected (the
 * defaults shell out to `gh` / the filesystem) so the command is unit-testable
 * without network or disk.
 */
export type AuditIssuesOptions = {
  /** Audit a single GitHub issue by number. */
  issue?: number;
  /** Audit a local draft body file (pre-file second pass); no GitHub access. */
  bodyFile?: string;
  /** Title to pair with `--body-file` (anchors the suggested rewrite). */
  title?: string;
  /** Apply `needs-design` to failing issues (GitHub modes only). Off by default. */
  label?: boolean;
  /** Emit machine-readable JSON instead of human lines. */
  json?: boolean;
  /** Resolve `owner/name` from a checkout (defaults to git remote of `repoPath`). */
  resolveSlug?: (repoPath: string) => Promise<string | null>;
  /** Fetch one issue (defaults to `gh issue view`). */
  fetchIssue?: (slug: string, n: number) => Promise<IssueLike | null>;
  /** List all open issues with bodies + labels (defaults to `gh issue list`). */
  listOpenIssues?: (slug: string) => Promise<IssueLike[]>;
  /** Apply a label to an issue (defaults to `gh issue edit --add-label`). */
  addLabel?: (slug: string, n: number, label: string) => Promise<void>;
  /** Read a local file (defaults to fs). */
  readBodyFile?: (path: string) => Promise<string>;
  log?: (msg: string) => void;
  errlog?: (msg: string) => void;
};

type RunResult = { stdout: string; stderr: string; exitCode: number };
async function gh(argv: string[]): Promise<RunResult> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exitCode: await proc.exited };
}

function labelsOf(raw: { labels?: { name: string }[] }): string[] {
  return (raw.labels ?? []).map((l) => l.name);
}

async function resolveSlugDefault(repoPath: string): Promise<string | null> {
  const res = await gh(["git", "-C", repoPath, "remote", "get-url", "origin"]);
  if (res.exitCode !== 0) return null;
  const m = /[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?\s*$/.exec(res.stdout.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

async function fetchIssueDefault(slug: string, n: number): Promise<IssueLike | null> {
  const res = await gh([
    "gh",
    "issue",
    "view",
    String(n),
    "--repo",
    slug,
    "--json",
    "number,title,body,labels",
  ]);
  if (res.exitCode !== 0) return null;
  const raw = JSON.parse(res.stdout) as {
    number: number;
    title: string;
    body: string;
    labels?: { name: string }[];
  };
  return { number: raw.number, title: raw.title, body: raw.body ?? "", labels: labelsOf(raw) };
}

async function listOpenIssuesDefault(slug: string): Promise<IssueLike[]> {
  const res = await gh([
    "gh",
    "issue",
    "list",
    "--repo",
    slug,
    "--state",
    "open",
    "--limit",
    "1000",
    "--json",
    "number,title,body,labels",
  ]);
  if (res.exitCode !== 0) throw new Error(res.stderr.trim() || "gh issue list failed");
  const rows = JSON.parse(res.stdout) as {
    number: number;
    title: string;
    body: string;
    labels?: { name: string }[];
  }[];
  return rows.map((r) => ({
    number: r.number,
    title: r.title,
    body: r.body ?? "",
    labels: labelsOf(r),
  }));
}

async function addLabelDefault(slug: string, n: number, label: string): Promise<void> {
  const res = await gh(["gh", "issue", "edit", String(n), "--repo", slug, "--add-label", label]);
  // Fail loudly: a non-zero `gh` exit means the label was NOT applied, and the
  // caller must not log it as applied. Propagate so the failure surfaces.
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || `gh issue edit --add-label failed for ${slug}#${n}`);
  }
}

/**
 * `mm audit-issues <repo>` — audit issue acceptance criteria against the
 * integration rubric (Epic #143). Three modes:
 *
 * - `--body-file <path>` — audit a local draft body before it's filed (the
 *   `creating-github-issues` second pass). No GitHub access.
 * - `--issue <n>` — audit one GitHub issue.
 * - neither — a standing backlog audit over every open feature issue, optionally
 *   labelling failures `needs-design` (`--label`).
 *
 * Exit code is 0 when every audited issue passes the rubric, 1 when any fails —
 * so it doubles as a gate the skill and the backlog-audit cron can branch on.
 */
export async function runAuditIssues(
  repoPath: string,
  opts: AuditIssuesOptions = {},
): Promise<number> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const errlog = opts.errlog ?? ((m: string) => console.error(m));

  // --- Mode 1: local draft body (no GitHub) ---
  if (opts.bodyFile) {
    let body: string;
    try {
      body = await (opts.readBodyFile ?? ((p) => readFile(p, "utf8")))(opts.bodyFile);
    } catch (error) {
      errlog(`mm audit-issues: cannot read ${opts.bodyFile} — ${(error as Error).message}`);
      return 1;
    }
    const finding = auditIssueBody(body, { title: opts.title });
    const report: IssueAuditReport = { number: 0, title: opts.title ?? "", finding };
    emit([report], opts.json ?? false, log);
    return finding.pass ? 0 : 1;
  }

  const slug = await (opts.resolveSlug ?? resolveSlugDefault)(repoPath);
  if (!slug) {
    errlog(`mm audit-issues: could not resolve owner/name from "${repoPath}" (no origin remote?)`);
    return 1;
  }

  // --- Mode 2: a single issue ---
  if (opts.issue !== undefined) {
    let issue: IssueLike | null;
    try {
      issue = await (opts.fetchIssue ?? fetchIssueDefault)(slug, opts.issue);
    } catch (error) {
      errlog(
        `mm audit-issues: failed to fetch ${slug}#${opts.issue} — ${(error as Error).message}`,
      );
      return 1;
    }
    if (!issue) {
      errlog(`mm audit-issues: could not fetch ${slug}#${opts.issue}`);
      return 1;
    }
    const report = auditIssue(issue);
    emit([report], opts.json ?? false, log);
    if (!report.finding.pass && opts.label) {
      // A label-write failure must surface (never be logged as applied), but it
      // shouldn't crash the command — the audit verdict still stands.
      try {
        await (opts.addLabel ?? addLabelDefault)(slug, issue.number, NEEDS_DESIGN_LABEL);
        log(`  → labelled #${issue.number} ${NEEDS_DESIGN_LABEL}`);
      } catch (error) {
        errlog(`  → failed to label #${issue.number} — ${(error as Error).message}`);
      }
    }
    return report.finding.pass ? 0 : 1;
  }

  // --- Mode 3: standing backlog audit ---
  let issues: IssueLike[];
  try {
    issues = await (opts.listOpenIssues ?? listOpenIssuesDefault)(slug);
  } catch (error) {
    errlog(`mm audit-issues: ${(error as Error).message}`);
    return 1;
  }
  const reports = auditIssues(issues);
  emit(reports, opts.json ?? false, log);
  const failures = reports.filter((r) => !r.finding.pass);
  if (opts.label) {
    // Isolate per-issue label failures so one bad write neither aborts the sweep
    // nor escapes as an unhandled rejection (mirrors the dispatcher's backlog audit).
    for (const r of failures) {
      try {
        await (opts.addLabel ?? addLabelDefault)(slug, r.number, NEEDS_DESIGN_LABEL);
        log(`  → labelled #${r.number} ${NEEDS_DESIGN_LABEL}`);
      } catch (error) {
        errlog(`  → failed to label #${r.number} — ${(error as Error).message}`);
      }
    }
  }
  if (!opts.json) {
    log(
      `\n${reports.length} feature issue(s) audited — ${reports.length - failures.length} pass, ${failures.length} fail`,
    );
  }
  return failures.length === 0 ? 0 : 1;
}

function emit(reports: IssueAuditReport[], json: boolean, log: (m: string) => void): void {
  if (json) {
    log(JSON.stringify(reports, null, 2));
    return;
  }
  for (const r of reports) log(formatReport(r));
}
