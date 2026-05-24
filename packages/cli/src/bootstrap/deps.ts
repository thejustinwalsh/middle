import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BootstrapDeps, GithubGateway, RepoInfo } from "./types.ts";
import { STATE_ISSUE_TITLE, STATE_LABEL, STATE_LABEL_COLOR } from "./types.ts";

type RunResult = { stdout: string; stderr: string; exitCode: number };

async function run(argv: string[], opts: { cwd?: string; stdin?: string } = {}): Promise<RunResult> {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exitCode: await proc.exited };
}

/** Parse `owner/name` from a GitHub remote URL (SSH or HTTPS). */
export function parseRepoSlug(url: string): { owner: string; name: string } | null {
  const match = /[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? { owner: match[1]!, name: match[2]! } : null;
}

const realGithub: GithubGateway = {
  async ensureStateLabel(info: RepoInfo): Promise<void> {
    const result = await run([
      "gh", "label", "create", STATE_LABEL,
      "--repo", `${info.owner}/${info.name}`,
      "--color", STATE_LABEL_COLOR,
      "--description", "Maintained by middle-management",
    ]);
    // gh exits non-zero if the label already exists — that's the desired state.
    if (result.exitCode !== 0 && !/already exists/i.test(result.stderr)) {
      throw new Error(`gh label create failed: ${result.stderr.trim()}`);
    }
  },

  async findStateIssues(info: RepoInfo): Promise<number[]> {
    const result = await run([
      "gh", "issue", "list",
      "--repo", `${info.owner}/${info.name}`,
      "--label", STATE_LABEL,
      "--state", "open",
      // `gh issue list` defaults to 30, newest-first — without a high limit the
      // canonical *oldest* state issue can be truncated off, breaking reuse.
      "--limit", "1000",
      "--json", "number,title,createdAt",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`gh issue list failed: ${result.stderr.trim()}`);
    }
    const rows = JSON.parse(result.stdout) as Array<{
      number: number;
      title: string;
      createdAt: string;
    }>;
    // Match the canonical title too — defends against the label being applied to
    // an unrelated issue. Oldest-first: the original is canonical, duplicates newer.
    return rows
      .filter((r) => r.title === STATE_ISSUE_TITLE)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map((r) => r.number);
  },

  async createStateIssue(info: RepoInfo, title: string, body: string): Promise<number> {
    const bodyFile = join(tmpdir(), `middle-state-issue-${Date.now()}.md`);
    await writeFile(bodyFile, body);
    try {
      const result = await run([
        "gh", "issue", "create",
        "--repo", `${info.owner}/${info.name}`,
        "--label", STATE_LABEL,
        "--title", title,
        "--body-file", bodyFile,
      ]);
      if (result.exitCode !== 0) {
        throw new Error(`gh issue create failed: ${result.stderr.trim()}`);
      }
      const match = /\/issues\/(\d+)/.exec(result.stdout);
      if (!match) throw new Error(`could not parse issue number from: ${result.stdout.trim()}`);
      return Number(match[1]);
    } finally {
      await rm(bodyFile, { force: true });
    }
  },

  async closeStateIssue(info: RepoInfo, issue: number, comment: string): Promise<void> {
    if (issue <= 0) return;
    const result = await run([
      "gh", "issue", "close", String(issue),
      "--repo", `${info.owner}/${info.name}`,
      "--reason", "not planned",
      "--comment", comment,
    ]);
    if (result.exitCode !== 0 && !/could not be found|already closed/i.test(result.stderr)) {
      throw new Error(`gh issue close failed: ${result.stderr.trim()}`);
    }
  },
};

/** The production `BootstrapDeps` — shells out to `git` and `gh`. */
export const realDeps: BootstrapDeps = {
  async isCleanWorktree(repo: string): Promise<boolean> {
    const result = await run(["git", "-C", repo, "status", "--porcelain"]);
    return result.exitCode === 0 && result.stdout.trim() === "";
  },

  async getRemoteUrl(repo: string): Promise<string | null> {
    const result = await run(["git", "-C", repo, "remote", "get-url", "origin"]);
    const url = result.stdout.trim();
    return result.exitCode === 0 && url ? url : null;
  },

  async isGhAuthenticated(): Promise<boolean> {
    if (!Bun.which("gh")) return false;
    return (await run(["gh", "auth", "status"])).exitCode === 0;
  },

  async resolveRepoInfo(repo: string): Promise<RepoInfo> {
    const url = (await this.getRemoteUrl(repo)) ?? "";
    const slug = parseRepoSlug(url);
    if (!slug) throw new Error(`could not parse owner/name from origin remote: "${url}"`);
    const branch = await run([
      "gh", "repo", "view", `${slug.owner}/${slug.name}`,
      "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name",
    ]);
    const defaultBranch = branch.exitCode === 0 && branch.stdout.trim() ? branch.stdout.trim() : "main";
    return { owner: slug.owner, name: slug.name, defaultBranch };
  },

  github: realGithub,
  now: () => new Date(),
};
