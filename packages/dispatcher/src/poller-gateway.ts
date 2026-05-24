import type { GitHubPollGateway, IssueComment, PrReview, PrSnapshot } from "./poller.ts";

/**
 * The production {@link GitHubPollGateway} — reads issue comments and PR review
 * state through the `gh` CLI. The poller's logic is unit-tested against an
 * injected stub gateway; this is the thin subprocess glue that backs it in the
 * dispatcher. Read-only: the poller never writes to GitHub.
 */

async function gh(argv: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0) {
    throw new Error(`gh ${argv.join(" ")} failed: ${stderr.trim()}`);
  }
  return stdout;
}

function isBotLogin(login: string, type: string | undefined): boolean {
  return type === "Bot" || login.endsWith("[bot]");
}

export const ghPollGateway: GitHubPollGateway = {
  async listIssueComments(repo: string, issueNumber: number): Promise<IssueComment[]> {
    // `--slurp` wraps the per-page arrays into one outer array; `gh` without it
    // emits one JSON array *per page*, which `JSON.parse` chokes on past page 1.
    const out = await gh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/issues/${issueNumber}/comments`,
    ]);
    const rows = (
      JSON.parse(out) as Array<
        Array<{
          id: number;
          body: string;
          created_at: string;
          user: { login: string; type?: string } | null;
        }>
      >
    ).flat();
    return rows.map((r) => ({
      id: r.id,
      body: r.body ?? "",
      createdAt: Date.parse(r.created_at),
      authorLogin: r.user?.login ?? "",
      authorIsBot: isBotLogin(r.user?.login ?? "", r.user?.type),
    }));
  },

  async findPrForEpic(repo: string, epicNumber: number): Promise<PrSnapshot | null> {
    // The Epic's one PR closes the Epic — find the open PR referencing it.
    const listOut = await gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--search",
      `in:body Closes #${epicNumber}`,
      "--json",
      "number",
    ]);
    const prs = JSON.parse(listOut) as Array<{ number: number }>;
    const prNumber = prs[0]?.number;
    if (prNumber === undefined) return null;

    const viewOut = await gh([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "reviewDecision,labels",
    ]);
    const view = JSON.parse(viewOut) as {
      reviewDecision: string | null;
      labels: Array<{ name: string }>;
    };

    const reviewsOut = await gh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/pulls/${prNumber}/reviews`,
    ]);
    const reviewRows = (
      JSON.parse(reviewsOut) as Array<
        Array<{
          id: number;
          state: string;
          body: string;
          submitted_at: string | null;
          user: { login: string } | null;
        }>
      >
    ).flat();
    const reviews: PrReview[] = reviewRows.map((r) => ({
      id: r.id,
      state: r.state,
      body: r.body ?? "",
      submittedAt: r.submitted_at ? Date.parse(r.submitted_at) : 0,
      authorLogin: r.user?.login ?? "",
    }));

    return {
      number: prNumber,
      reviewDecision: view.reviewDecision ?? null,
      reviews,
      labels: view.labels.map((l) => l.name),
    };
  },
};
