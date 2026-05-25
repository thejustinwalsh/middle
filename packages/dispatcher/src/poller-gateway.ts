import type {
  CiStatus,
  EpicPrLifecycle,
  GitHubPollGateway,
  IssueComment,
  PrReview,
  PrSnapshot,
  RateLimitStatus,
} from "./poller.ts";

/**
 * One `statusCheckRollup` entry as `gh pr view` returns it. A **CheckRun**
 * (GitHub Actions / most apps) reports `status` + `conclusion`; a **StatusContext**
 * (legacy commit statuses) reports a single `state`. We read whichever is present.
 */
export type CheckRollupEntry = {
  status?: string; // CheckRun: QUEUED | IN_PROGRESS | COMPLETED
  conclusion?: string; // CheckRun: SUCCESS | FAILURE | NEUTRAL | CANCELLED | TIMED_OUT | ...
  state?: string; // StatusContext: SUCCESS | FAILURE | ERROR | PENDING
};

const CONCLUSION_OK = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const STATE_OK = new Set(["SUCCESS", "EXPECTED"]);

/**
 * Collapse a `statusCheckRollup` array into a single {@link CiStatus}. Any
 * failing check ⇒ `failing` (a red build can't be reviewed); else any still-
 * running check ⇒ `pending`; else `passing`. An empty/absent rollup ⇒ `none`
 * (no checks configured — nothing to gate on). Pure, so it's unit-tested directly.
 */
export function deriveCiStatus(rollup: CheckRollupEntry[] | null | undefined): CiStatus {
  if (!rollup || rollup.length === 0) return "none";
  let pending = false;
  for (const c of rollup) {
    if (c.status !== undefined && c.status !== "COMPLETED") {
      pending = true; // a CheckRun that hasn't finished
      continue;
    }
    if (c.conclusion !== undefined) {
      if (!CONCLUSION_OK.has(c.conclusion)) return "failing";
      continue;
    }
    // StatusContext (no status/conclusion) — read `state`.
    if (c.state !== undefined) {
      if (c.state === "PENDING") pending = true;
      else if (!STATE_OK.has(c.state)) return "failing"; // FAILURE / ERROR
    }
  }
  return pending ? "pending" : "passing";
}

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
    // The server-side search is a prefix match, so `Closes #3` also surfaces
    // `Closes #30`/`#300`; re-confirm the exact closing reference client-side on
    // the returned bodies, anchoring the number with a non-digit boundary.
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
      "number,body",
    ]);
    const closesRe = new RegExp(`\\bcloses\\s+#${epicNumber}(?!\\d)`, "i");
    const prs = JSON.parse(listOut) as Array<{ number: number; body: string | null }>;
    const prNumber = prs.find((pr) => closesRe.test(pr.body ?? ""))?.number;
    if (prNumber === undefined) return null;

    const viewOut = await gh([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "reviewDecision,labels,statusCheckRollup",
    ]);
    const view = JSON.parse(viewOut) as {
      reviewDecision: string | null;
      labels: Array<{ name: string }>;
      statusCheckRollup: CheckRollupEntry[] | null;
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
      ci: deriveCiStatus(view.statusCheckRollup),
    };
  },

  async findEpicPrLifecycle(repo: string, epicNumber: number): Promise<EpicPrLifecycle | null> {
    // Same `Closes #<epic>` linkage as findPrForEpic, but across ALL states so a
    // merged/closed PR is visible. The server-side search is a prefix match, so
    // re-confirm the exact closing reference client-side (anchored boundary).
    const listOut = await gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--search",
      `in:body Closes #${epicNumber}`,
      "--json",
      "number,body,state",
    ]);
    const closesRe = new RegExp(`\\bcloses\\s+#${epicNumber}(?!\\d)`, "i");
    const matches = (
      JSON.parse(listOut) as Array<{ number: number; body: string | null; state: string }>
    ).filter((pr) => closesRe.test(pr.body ?? ""));
    if (matches.length === 0) return null;
    // Precedence when an Epic has more than one matching PR across its history
    // (e.g. a rejected-and-reopened workstream): an OPEN PR means work is still
    // live — never reconcile it; otherwise a MERGED one wins over a stale CLOSED.
    const norm = (s: string): "OPEN" | "MERGED" | "CLOSED" =>
      s === "OPEN" ? "OPEN" : s === "MERGED" ? "MERGED" : "CLOSED";
    const rank = { OPEN: 0, MERGED: 1, CLOSED: 2 } as const;
    const best = matches.reduce((a, b) => (rank[norm(a.state)] <= rank[norm(b.state)] ? a : b));
    return { number: best.number, state: norm(best.state) };
  },

  async getRateLimit(): Promise<RateLimitStatus> {
    // The `rate_limit` endpoint is special-cased by GitHub: querying it does
    // NOT consume budget. `core.reset` is epoch *seconds* → convert to ms.
    const out = await gh([
      "api",
      "rate_limit",
      "--jq",
      "{ remaining: .resources.core.remaining, reset: .resources.core.reset }",
    ]);
    const r = JSON.parse(out) as { remaining: number; reset: number };
    return { remaining: r.remaining, resetAt: r.reset * 1000 };
  },
};
