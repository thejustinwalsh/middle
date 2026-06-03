import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssueComment } from "./gates/plan-comment.ts";

/**
 * The GitHub access seam the skill-enforcement gates depend on. Modeled on the
 * `StateGateway` in `state-issue.ts`: a narrow interface the gates take as
 * an injected dependency (so they're testable against in-memory stubs) plus a
 * single `gh`-CLI-backed production implementation (`ghGitHub`).
 *
 * GitHub is the system of record; everything here reads/writes it through `gh`.
 */
export type PullRequest = {
  number: number;
  body: string;
  isDraft: boolean;
  /**
   * The PR's head commit SHA (`headRefOid`). The checkbox-revert pass diffs this
   * across poller ticks to detect that the agent pushed (so it only re-runs gates
   * when the PR actually advanced). Optional: a stub gateway may omit it, in which
   * case the pass falls back to the reconciler's own checkbox-state diff.
   */
  headSha?: string;
};

/** A comment's author, resolved from a comment URL — for the PR-ready deferral check. */
export type CommentAuthor = {
  login: string;
  isBot: boolean;
};

/** An open Epic discovered from a store (GitHub issues or local files), with its sub-issue progress. */
export type EpicListItem = {
  /** Canonical Epic reference: `String(number)` in github mode, the slug in file mode. */
  ref: string;
  /** GitHub issue number; `null` for a file-mode Epic (which has only a slug). */
  number: number | null;
  title: string;
  state: string;
  labels: string[];
  subTotal: number;
  subClosed: number;
};

/** A plain open issue with the fields the requirements/staleness audits read. */
export type IssueSummary = {
  number: number;
  title: string;
  body: string;
  labels: string[];
};

/** A merged PR and the issue numbers GitHub records it as closing. */
export type MergedPrRef = {
  number: number;
  closes: number[];
};

/** Fields for filing a new issue (the anti-staleness reconcile task). */
export type NewIssue = {
  title: string;
  body: string;
  labels?: string[];
};

/**
 * Parse NDJSON (one issue object per line) into the Epic rows we cache. Each
 * line is one issue object emitted by `gh api --paginate` with a `--jq` filter
 * of `.[] | select(.pull_request == null)` (so PR objects are already excluded
 * before we see them). An Epic is an issue with ≥1 sub-issue
 * (`sub_issues_summary.total > 0`); rows without a summary or with no
 * sub-issues are dropped. Blank lines are tolerated.
 */
export function parseEpicsList(stdout: string): EpicListItem[] {
  const out: EpicListItem[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const issue = JSON.parse(trimmed) as {
      number: number;
      title: string;
      state: string;
      labels?: { name: string }[];
      sub_issues_summary?: { total: number; completed: number };
    };
    const summary = issue.sub_issues_summary;
    if (!summary || summary.total <= 0) continue;
    out.push({
      ref: String(issue.number),
      number: issue.number,
      title: issue.title,
      state: issue.state,
      labels: (issue.labels ?? []).map((l) => l.name),
      subTotal: summary.total,
      subClosed: summary.completed,
    });
  }
  return out;
}

/**
 * The Epic-store gateway. The issue/Epic identifier flows as a string `ref` (the
 * "string-keyed seam"): the stringified issue number in github mode, a file slug
 * in file mode. The github implementation (`ghGitHub`) parses each `ref` back to
 * an integer at its `gh`-CLI boundary (see {@link refToIssueNumber}); a file
 * implementation reads the ref as a slug. PR numbers and comment ids stay
 * numeric — PRs/reviews are GitHub-native in both modes.
 */
export interface EpicGateway {
  /** Comments on an issue or PR (PRs are issues for the comments endpoint). */
  listIssueComments(repo: string, ref: string): Promise<IssueComment[]>;
  /** The open PR for an Epic — the one whose body closes the Epic referenced by `epicRef`. */
  findEpicPr(repo: string, epicRef: string): Promise<PullRequest | null>;
  /** A single PR by number. */
  getPullRequest(repo: string, prNumber: number): Promise<PullRequest | null>;
  /** Overwrite a PR's body (used by the checkbox-revert reconciler). */
  editPullRequestBody(repo: string, prNumber: number, body: string): Promise<void>;
  /** Post a comment on an issue or PR (`ref` is the issue/Epic ref; PR comments pass the PR number as the ref). */
  postComment(repo: string, ref: string, body: string): Promise<void>;
  /** Edit an existing issue/PR comment in place (used to upsert gate evidence). */
  editComment(repo: string, commentId: number, body: string): Promise<void>;
  /** Resolve the author of a comment from its URL; null if unresolvable. */
  getCommentAuthor(repo: string, commentUrl: string): Promise<CommentAuthor | null>;
  /** The label names on an issue/Epic (e.g. to check for `approved`). */
  getIssueLabels(repo: string, ref: string): Promise<string[]>;
  /** Open Epics in a repo (issues with ≥1 sub-issue), each with sub-issue progress. */
  listOpenEpics(repo: string): Promise<EpicListItem[]>;
  /** Every open issue (not PRs) with body + labels — for the requirements/staleness audits. */
  listOpenIssues(repo: string): Promise<IssueSummary[]>;
  /** Add a label to an issue (no-op if already present). */
  addLabel(repo: string, ref: string, label: string): Promise<void>;
  /** Recently-merged PRs and the issues each closes — for landed-but-open detection. */
  listMergedPrsClosingRefs(repo: string): Promise<MergedPrRef[]>;
  /** Close an issue with an evidence comment (the anti-staleness reconcile trail). */
  closeIssue(repo: string, ref: string, comment: string): Promise<void>;
  /** File a new issue (the proposal-first reconcile task). Returns its number. */
  createIssue(repo: string, issue: NewIssue): Promise<number>;
}

/**
 * Parse a string Epic/issue `ref` to the integer GitHub issue number `gh`
 * requires. github mode's contract is numeric-string refs only; a slug (the
 * file-mode reference) is rejected here with a clear error rather than silently
 * coercing to `NaN` and producing a confusing `gh` failure downstream.
 */
export function refToIssueNumber(ref: string): number {
  if (!/^\d+$/.test(ref.trim())) {
    throw new Error(
      `github mode requires a numeric issue/Epic reference, got "${ref}" (file-mode slugs are not valid here)`,
    );
  }
  return Number(ref.trim());
}

async function run(
  argv: string[],
  stdin?: string,
): Promise<{ stdout: string; exitCode: number; stderr: string }> {
  const proc = Bun.spawn(argv, {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exitCode: await proc.exited };
}

/** A login is a bot if GitHub types it `Bot` or its login carries the `[bot]` suffix. */
function isBotAuthor(login: string, type: string | undefined): boolean {
  return type === "Bot" || login.endsWith("[bot]");
}

/** Parse `owner/name` for use in `gh api /repos/{owner}/{name}/...` paths. */
function ownerRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split("/");
  return { owner: owner ?? "", name: name ?? "" };
}

/**
 * The `owner/name` a comment lives in, taken from the comment URL itself (which
 * encodes it: `https://github.com/{owner}/{name}/issues|pull/...`). The URL is
 * authoritative — a single daemon serves many repos, so a comment's repo must
 * come from the comment, not from an ambient slug. Falls back to `fallbackRepo`
 * only when the URL doesn't carry it.
 */
function repoFromCommentUrl(url: string, fallbackRepo: string): { owner: string; name: string } {
  const match = /github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\//.exec(url);
  if (match) return { owner: match[1]!, name: match[2]! };
  return ownerRepo(fallbackRepo);
}

/** The gh-authenticated account's login (the identity the agent posts as), or undefined. */
export async function resolveAgentLogin(): Promise<string | undefined> {
  const result = await run(["gh", "api", "user", "--jq", ".login"]);
  if (result.exitCode !== 0) return undefined;
  const login = result.stdout.trim();
  return login === "" ? undefined : login;
}

export const ghGitHub: EpicGateway = {
  async listIssueComments(repo, ref) {
    const issueNumber = refToIssueNumber(ref);
    const result = await run([
      "gh",
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "comments",
      "--jq",
      ".comments[] | {authorLogin: .author.login, body: .body, url: .url}",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`gh issue view #${issueNumber} comments failed: ${result.stderr.trim()}`);
    }
    // `--jq` emits one JSON object per line (JSON Lines), not a JSON array.
    return result.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as IssueComment);
  },

  async findEpicPr(repo, epicRef) {
    const epicNumber = refToIssueNumber(epicRef);
    const result = await run([
      "gh",
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--json",
      "number,body,isDraft,headRefOid",
      "--limit",
      "100",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`gh pr list failed: ${result.stderr.trim()}`);
    }
    // `gh` returns `headRefOid`; map it onto the `headSha` field the gateway exposes.
    const prs: PullRequest[] = (
      JSON.parse(result.stdout) as Array<{
        number: number;
        body: string;
        isDraft: boolean;
        headRefOid?: string;
      }>
    ).map((pr) => ({
      number: pr.number,
      body: pr.body,
      isDraft: pr.isDraft,
      headSha: pr.headRefOid,
    }));
    // The Epic PR is the one that closes the Epic. Match a GitHub closing
    // keyword referencing the exact Epic number (word-boundaried so #27 doesn't
    // match #270).
    const closes = new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s+#${epicNumber}\\b`, "i");
    return prs.find((pr) => closes.test(pr.body)) ?? null;
  },

  async getIssueLabels(repo, ref) {
    const issueNumber = refToIssueNumber(ref);
    const result = await run([
      "gh",
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "labels",
      "--jq",
      ".labels[].name",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`gh issue view #${issueNumber} labels failed: ${result.stderr.trim()}`);
    }
    return result.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
  },

  async listOpenEpics(repo) {
    const { owner, name } = ownerRepo(repo);
    const result = await run([
      "gh",
      "api",
      "--paginate",
      `repos/${owner}/${name}/issues`,
      "-X",
      "GET",
      "-f",
      "state=open",
      "-F",
      "per_page=100",
      "--jq",
      ".[] | select(.pull_request == null)",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`gh api list issues for ${repo} failed: ${result.stderr.trim()}`);
    }
    return parseEpicsList(result.stdout);
  },

  async listOpenIssues(repo) {
    const result = await run([
      "gh",
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      "1000",
      "--json",
      "number,title,body,labels",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`gh issue list for ${repo} failed: ${result.stderr.trim()}`);
    }
    const rows = JSON.parse(result.stdout) as {
      number: number;
      title: string;
      body: string;
      labels?: { name: string }[];
    }[];
    return rows.map((r) => ({
      number: r.number,
      title: r.title,
      body: r.body ?? "",
      labels: (r.labels ?? []).map((l) => l.name),
    }));
  },

  async addLabel(repo, ref, label) {
    const issueNumber = refToIssueNumber(ref);
    const result = await run([
      "gh",
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--add-label",
      label,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `gh issue edit #${issueNumber} --add-label ${label} failed: ${result.stderr.trim()}`,
      );
    }
  },

  async listMergedPrsClosingRefs(repo) {
    const result = await run([
      "gh",
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "merged",
      "--limit",
      "100",
      "--json",
      "number,closingIssuesReferences",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`gh pr list --state merged for ${repo} failed: ${result.stderr.trim()}`);
    }
    const rows = JSON.parse(result.stdout) as {
      number: number;
      closingIssuesReferences?: { number: number }[];
    }[];
    return rows.map((r) => ({
      number: r.number,
      closes: (r.closingIssuesReferences ?? []).map((c) => c.number),
    }));
  },

  async closeIssue(repo, ref, comment) {
    const issueNumber = refToIssueNumber(ref);
    const result = await run([
      "gh",
      "issue",
      "close",
      String(issueNumber),
      "--repo",
      repo,
      "--reason",
      "completed",
      "--comment",
      comment,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`gh issue close #${issueNumber} failed: ${result.stderr.trim()}`);
    }
  },

  async createIssue(repo, issue) {
    const bodyFile = join(tmpdir(), `middle-new-issue-${Date.now()}.md`);
    await writeFile(bodyFile, issue.body);
    try {
      const argv = [
        "gh",
        "issue",
        "create",
        "--repo",
        repo,
        "--title",
        issue.title,
        "--body-file",
        bodyFile,
      ];
      for (const label of issue.labels ?? []) argv.push("--label", label);
      const result = await run(argv);
      if (result.exitCode !== 0) {
        throw new Error(`gh issue create failed: ${result.stderr.trim()}`);
      }
      // gh prints the new issue URL; the trailing path segment is its number.
      const m = /\/(\d+)\s*$/.exec(result.stdout.trim());
      if (!m) {
        throw new Error(
          `gh issue create: could not parse issue number from "${result.stdout.trim()}"`,
        );
      }
      return Number(m[1]);
    } finally {
      await rm(bodyFile, { force: true });
    }
  },

  async getPullRequest(repo, prNumber) {
    const result = await run([
      "gh",
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "number,body,isDraft,headRefOid",
    ]);
    if (result.exitCode !== 0) return null;
    const pr = JSON.parse(result.stdout) as {
      number: number;
      body: string;
      isDraft: boolean;
      headRefOid?: string;
    };
    return { number: pr.number, body: pr.body, isDraft: pr.isDraft, headSha: pr.headRefOid };
  },

  async editPullRequestBody(repo, prNumber, body) {
    const bodyFile = join(tmpdir(), `middle-pr-body-${prNumber}-${Date.now()}.md`);
    await writeFile(bodyFile, body);
    try {
      const result = await run([
        "gh",
        "pr",
        "edit",
        String(prNumber),
        "--repo",
        repo,
        "--body-file",
        bodyFile,
      ]);
      if (result.exitCode !== 0) {
        throw new Error(`gh pr edit #${prNumber} failed: ${result.stderr.trim()}`);
      }
    } finally {
      await rm(bodyFile, { force: true });
    }
  },

  async postComment(repo, ref, body) {
    const issueNumber = refToIssueNumber(ref);
    const result = await run(
      ["gh", "issue", "comment", String(issueNumber), "--repo", repo, "--body-file", "-"],
      body,
    );
    if (result.exitCode !== 0) {
      throw new Error(`gh issue comment #${issueNumber} failed: ${result.stderr.trim()}`);
    }
  },

  async editComment(repo, commentId, body) {
    const { owner, name } = ownerRepo(repo);
    // PATCH the comment with a JSON request body piped on stdin (`--input -`).
    // `-f body=...` is unsafe here: --raw-field takes the value literally (so
    // `@-` wouldn't read stdin) and a long multiline body fights shell quoting.
    const result = await run(
      [
        "gh",
        "api",
        "--method",
        "PATCH",
        `/repos/${owner}/${name}/issues/comments/${commentId}`,
        "--input",
        "-",
      ],
      JSON.stringify({ body }),
    );
    if (result.exitCode !== 0) {
      throw new Error(`gh api PATCH comment ${commentId} failed: ${result.stderr.trim()}`);
    }
  },

  async getCommentAuthor(repo, commentUrl) {
    const { owner, name } = repoFromCommentUrl(commentUrl, repo);
    if (owner === "" || name === "") {
      // Neither the URL nor the fallback yielded a repo — the API call would 404.
      // Surface it: the caller (the PR-ready gate's deferral-author check) will
      // treat an unresolved author as not-a-human and deny, so don't fail silently.
      console.error(`[github] getCommentAuthor: no repo for comment url ${commentUrl}`);
      return null;
    }
    // Comment URLs carry the comment id in their fragment:
    //   .../issues/27#issuecomment-123     → /repos/{o}/{r}/issues/comments/123
    //   .../pull/86#discussion_r456        → /repos/{o}/{r}/pulls/comments/456
    const issueComment = /#issuecomment-(\d+)/.exec(commentUrl);
    const reviewComment = /#discussion_r(\d+)/.exec(commentUrl);
    let apiPath: string;
    if (issueComment) {
      apiPath = `/repos/${owner}/${name}/issues/comments/${issueComment[1]}`;
    } else if (reviewComment) {
      apiPath = `/repos/${owner}/${name}/pulls/comments/${reviewComment[1]}`;
    } else {
      return null;
    }
    const result = await run([
      "gh",
      "api",
      apiPath,
      "--jq",
      "{login: .user.login, type: .user.type}",
    ]);
    if (result.exitCode !== 0) return null;
    const { login, type } = JSON.parse(result.stdout) as { login: string; type?: string };
    return { login, isBot: isBotAuthor(login, type) };
  },
};
