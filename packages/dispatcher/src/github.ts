import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssueComment } from "./gates/plan-comment.ts";

/**
 * The GitHub access seam the skill-enforcement gates depend on. Modeled on the
 * `StateIssueGateway` in `state-issue.ts`: a narrow interface the gates take as
 * an injected dependency (so they're testable against in-memory stubs) plus a
 * single `gh`-CLI-backed production implementation (`ghGitHub`).
 *
 * GitHub is the system of record; everything here reads/writes it through `gh`.
 */
export type PullRequest = {
  number: number;
  body: string;
  isDraft: boolean;
};

/** A comment's author, resolved from a comment URL — for the PR-ready deferral check. */
export type CommentAuthor = {
  login: string;
  isBot: boolean;
};

/** An open Epic discovered from GitHub's issues API, with its sub-issue progress. */
export type EpicListItem = {
  number: number;
  title: string;
  state: string;
  labels: string[];
  subTotal: number;
  subClosed: number;
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

export interface GitHubGateway {
  /** Comments on an issue or PR (PRs are issues for the comments endpoint). */
  listIssueComments(repo: string, issueNumber: number): Promise<IssueComment[]>;
  /** The open PR for an Epic — the one whose body closes `#epicNumber`. */
  findEpicPr(repo: string, epicNumber: number): Promise<PullRequest | null>;
  /** A single PR by number. */
  getPullRequest(repo: string, prNumber: number): Promise<PullRequest | null>;
  /** Overwrite a PR's body (used by the checkbox-revert reconciler). */
  editPullRequestBody(repo: string, prNumber: number, body: string): Promise<void>;
  /** Post a comment on an issue or PR. */
  postComment(repo: string, issueNumber: number, body: string): Promise<void>;
  /** Edit an existing issue/PR comment in place (used to upsert gate evidence). */
  editComment(repo: string, commentId: number, body: string): Promise<void>;
  /** Resolve the author of a comment from its URL; null if unresolvable. */
  getCommentAuthor(repo: string, commentUrl: string): Promise<CommentAuthor | null>;
  /** The label names on an issue/Epic (e.g. to check for `approved`). */
  getIssueLabels(repo: string, issueNumber: number): Promise<string[]>;
  /** Open Epics in a repo (issues with ≥1 sub-issue), each with sub-issue progress. */
  listOpenEpics(repo: string): Promise<EpicListItem[]>;
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

export const ghGitHub: GitHubGateway = {
  async listIssueComments(repo, issueNumber) {
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

  async findEpicPr(repo, epicNumber) {
    const result = await run([
      "gh",
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--json",
      "number,body,isDraft",
      "--limit",
      "100",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`gh pr list failed: ${result.stderr.trim()}`);
    }
    const prs = JSON.parse(result.stdout) as PullRequest[];
    // The Epic PR is the one that closes the Epic. Match a GitHub closing
    // keyword referencing the exact Epic number (word-boundaried so #27 doesn't
    // match #270).
    const closes = new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s+#${epicNumber}\\b`, "i");
    return prs.find((pr) => closes.test(pr.body)) ?? null;
  },

  async getIssueLabels(repo, issueNumber) {
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

  async getPullRequest(repo, prNumber) {
    const result = await run([
      "gh",
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "number,body,isDraft",
    ]);
    if (result.exitCode !== 0) return null;
    return JSON.parse(result.stdout) as PullRequest;
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

  async postComment(repo, issueNumber, body) {
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
