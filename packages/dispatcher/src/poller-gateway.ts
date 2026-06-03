import type {
  CiStatus,
  EpicPrLifecycle,
  PollGateway,
  IssueComment,
  PrReview,
  PrSnapshot,
  RateLimitStatus,
} from "./poller.ts";
import { refToIssueNumber } from "./github.ts";

/**
 * One `statusCheckRollup` entry as `gh pr view` returns it. A **CheckRun**
 * (GitHub Actions / most apps) reports `status` + `conclusion`; a **StatusContext**
 * (legacy commit statuses) reports a single `state`. We read whichever is present.
 */
export type CheckRollupEntry = {
  status?: string; // CheckRun: QUEUED | IN_PROGRESS | COMPLETED
  conclusion?: string; // CheckRun: SUCCESS | FAILURE | NEUTRAL | CANCELLED | TIMED_OUT | ...
  state?: string; // StatusContext: SUCCESS | FAILURE | ERROR | PENDING | EXPECTED
};

const CONCLUSION_OK = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const STATE_OK = new Set(["SUCCESS"]);
// `EXPECTED` is "a status is expected but not yet reported" — not final, so it's
// pending, never passing (a green gate must require an actual SUCCESS).
const STATE_PENDING = new Set(["PENDING", "EXPECTED"]);

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
      if (STATE_PENDING.has(c.state)) pending = true;
      else if (!STATE_OK.has(c.state)) return "failing"; // FAILURE / ERROR
    }
  }
  return pending ? "pending" : "passing";
}

/**
 * The production {@link PollGateway} — reads issue comments and PR review
 * state through the `gh` CLI. The poller's logic is unit-tested against an
 * injected stub gateway; this is the thin subprocess glue that backs it in the
 * dispatcher. Read-only: the poller never writes to GitHub.
 */

async function gh(argv: string[]): Promise<string> {
  // Pass `env` explicitly so argv[0] (`gh`) resolves against the *current*
  // `process.env.PATH` rather than Bun's process-start PATH snapshot. Identical
  // to the default inherited environment in production; it's what lets a test
  // shim `gh` on PATH to exercise the failure-isolation branches below.
  const proc = Bun.spawn(["gh", ...argv], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: process.env,
  });
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

/**
 * Build a {@link PrSnapshot} for a known PR number (review decision, individual
 * reviews, labels, CI). Shared by the Epic finder (which resolves the number via
 * `Closes #<n>`) and the by-number gateway method (file mode, which resolves it
 * from `meta.pr`). Returns `null` if the PR can't be viewed (e.g. it doesn't
 * exist), so a stale `meta.pr` degrades to "no PR" rather than throwing the pass.
 */
async function fetchPrSnapshot(repo: string, prNumber: number): Promise<PrSnapshot | null> {
  let viewOut: string;
  try {
    viewOut = await gh([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "reviewDecision,labels,statusCheckRollup",
    ]);
  } catch {
    return null;
  }
  const view = JSON.parse(viewOut) as {
    reviewDecision: string | null;
    labels: Array<{ name: string }>;
    statusCheckRollup: CheckRollupEntry[] | null;
  };

  let reviewsOut: string;
  try {
    reviewsOut = await gh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/pulls/${prNumber}/reviews`,
    ]);
  } catch {
    // Same isolation contract as the `pr view` fetch above: a transient reviews
    // failure (rate limit, network) degrades to "no PR" rather than throwing and
    // aborting the whole poll pass for every other parked workflow.
    return null;
  }
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
}

/** Lifecycle (state) for a known PR number. Returns `null` if the PR can't be
 *  viewed (stale `meta.pr` → "no PR" rather than a thrown pass). */
async function fetchPrLifecycle(repo: string, prNumber: number): Promise<EpicPrLifecycle | null> {
  let out: string;
  try {
    out = await gh(["pr", "view", String(prNumber), "--repo", repo, "--json", "state"]);
  } catch {
    return null;
  }
  const { state } = JSON.parse(out) as { state: string };
  const norm: "OPEN" | "MERGED" | "CLOSED" =
    state === "OPEN" ? "OPEN" : state === "MERGED" ? "MERGED" : "CLOSED";
  return { number: prNumber, state: norm };
}

export const ghPollGateway: PollGateway = {
  async listIssueComments(repo: string, ref: string): Promise<IssueComment[]> {
    const issueNumber = refToIssueNumber(ref);
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

  async findPrForEpic(repo: string, epicRef: string): Promise<PrSnapshot | null> {
    const epicNumber = refToIssueNumber(epicRef);
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
    return fetchPrSnapshot(repo, prNumber);
  },

  prSnapshot(repo: string, prNumber: number): Promise<PrSnapshot | null> {
    return fetchPrSnapshot(repo, prNumber);
  },

  prLifecycle(repo: string, prNumber: number): Promise<EpicPrLifecycle | null> {
    return fetchPrLifecycle(repo, prNumber);
  },

  async findEpicPrLifecycle(repo: string, epicRef: string): Promise<EpicPrLifecycle | null> {
    const epicNumber = refToIssueNumber(epicRef);
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
