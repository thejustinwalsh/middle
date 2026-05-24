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
  /** Resolve the author of a comment from its URL; null if unresolvable. */
  getCommentAuthor(repo: string, commentUrl: string): Promise<CommentAuthor | null>;
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
  return type === "Bot" || /\[bot\]$/.test(login);
}

/** Parse `owner/name` for use in `gh api /repos/{owner}/{name}/...` paths. */
function ownerRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split("/");
  return { owner: owner ?? "", name: name ?? "" };
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
      "gh", "issue", "view", String(issueNumber),
      "--repo", repo, "--json", "comments",
      "--jq", ".comments[] | {authorLogin: .author.login, body: .body, url: .url}",
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
      "gh", "pr", "list", "--repo", repo, "--state", "open",
      "--json", "number,body,isDraft", "--limit", "100",
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

  async getPullRequest(repo, prNumber) {
    const result = await run([
      "gh", "pr", "view", String(prNumber),
      "--repo", repo, "--json", "number,body,isDraft",
    ]);
    if (result.exitCode !== 0) return null;
    return JSON.parse(result.stdout) as PullRequest;
  },

  async editPullRequestBody(repo, prNumber, body) {
    const bodyFile = join(tmpdir(), `middle-pr-body-${prNumber}-${Date.now()}.md`);
    await writeFile(bodyFile, body);
    try {
      const result = await run([
        "gh", "pr", "edit", String(prNumber), "--repo", repo, "--body-file", bodyFile,
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

  async getCommentAuthor(repo, commentUrl) {
    const { owner, name } = ownerRepo(repo);
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
      "gh", "api", apiPath, "--jq", "{login: .user.login, type: .user.type}",
    ]);
    if (result.exitCode !== 0) return null;
    const { login, type } = JSON.parse(result.stdout) as { login: string; type?: string };
    return { login, isBot: isBotAuthor(login, type) };
  },
};
