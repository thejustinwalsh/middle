import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAndMigrate } from "../src/db.ts";
import {
  type ApplyDemoteGateway,
  applyDemoteToWork,
  classifyDivergence,
  classifyMergeability,
  type ClosedSubIssue,
  type DivergenceGateway,
  getDivergenceState,
  ghStderrIsNotFound,
  type MergeabilityView,
  parseEpicFromHeadRef,
  recordDivergenceState,
  worktreePathFor,
} from "../src/reconcilers/pr-divergence.ts";

let scratch: string;
let db: Database;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "middle-pr-div-"));
  db = openAndMigrate(join(scratch, "db.sqlite3"));
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const REPO = "thejustinwalsh/middle";

/** A gateway stub returning a fixed mergeability view, recording calls. */
function makeGateway(
  responses: Record<number, MergeabilityView | null>,
): DivergenceGateway & { calls: number } {
  const g = {
    calls: 0,
    async getMergeability(_repo: string, prNumber: number) {
      g.calls++;
      return responses[prNumber] ?? null;
    },
  };
  return g;
}

describe("classifyMergeability", () => {
  test("DIRTY → CONFLICTED regardless of mergeable", () => {
    expect(classifyMergeability({ mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" })).toBe(
      "CONFLICTED",
    );
    expect(classifyMergeability({ mergeStateStatus: "DIRTY", mergeable: "UNKNOWN" })).toBe(
      "CONFLICTED",
    );
  });

  test("BEHIND → BEHIND", () => {
    expect(classifyMergeability({ mergeStateStatus: "BEHIND", mergeable: "MERGEABLE" })).toBe(
      "BEHIND",
    );
  });

  test("CLEAN + MERGEABLE → CLEAN", () => {
    expect(classifyMergeability({ mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" })).toBe(
      "CLEAN",
    );
  });

  test("CLEAN but not MERGEABLE → UNKNOWN (CI gating, secondary signals)", () => {
    expect(classifyMergeability({ mergeStateStatus: "CLEAN", mergeable: "UNKNOWN" })).toBe(
      "UNKNOWN",
    );
  });

  test("BLOCKED / HAS_HOOKS / UNSTABLE / UNKNOWN → UNKNOWN", () => {
    for (const status of ["BLOCKED", "HAS_HOOKS", "UNSTABLE", "UNKNOWN"]) {
      expect(classifyMergeability({ mergeStateStatus: status, mergeable: "MERGEABLE" })).toBe(
        "UNKNOWN",
      );
    }
  });

  test("a null view (PR doesn't exist) → UNKNOWN", () => {
    expect(classifyMergeability(null)).toBe("UNKNOWN");
  });

  test("missing fields → UNKNOWN (legacy fixtures don't tip the classifier)", () => {
    expect(classifyMergeability({})).toBe("UNKNOWN");
    expect(classifyMergeability({ mergeStateStatus: "CLEAN" })).toBe("UNKNOWN");
    expect(classifyMergeability({ mergeable: "MERGEABLE" })).toBe("UNKNOWN");
  });
});

describe("classifyDivergence", () => {
  test("classifies BEHIND and persists the row with the supplied clock", async () => {
    const github = makeGateway({
      90: { mergeStateStatus: "BEHIND", mergeable: "MERGEABLE" },
    });
    const now = 1_700_000_000_000;

    expect(await classifyDivergence({ db, github, now: () => now }, REPO, 90)).toBe("BEHIND");

    expect(github.calls).toBe(1);
    expect(getDivergenceState(db, REPO, 90)).toEqual({ state: "BEHIND", classifiedAt: now });
  });

  test("classifies CONFLICTED and overwrites a prior row (upsert keeps the row fresh)", async () => {
    const github = makeGateway({
      90: { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" },
    });

    // Pre-existing stale row from an earlier pass.
    recordDivergenceState(db, REPO, 90, "BEHIND", 1_000);

    expect(await classifyDivergence({ db, github, now: () => 2_000 }, REPO, 90)).toBe("CONFLICTED");
    expect(getDivergenceState(db, REPO, 90)).toEqual({
      state: "CONFLICTED",
      classifiedAt: 2_000,
    });
  });

  test("classifies CLEAN", async () => {
    const github = makeGateway({
      91: { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" },
    });
    expect(await classifyDivergence({ db, github, now: () => 3_000 }, REPO, 91)).toBe("CLEAN");
    expect(getDivergenceState(db, REPO, 91)?.state).toBe("CLEAN");
  });

  test("classifies UNKNOWN for a PR with no mergeability view (gone / 404)", async () => {
    const github = makeGateway({}); // no entry for prNumber → returns null
    expect(await classifyDivergence({ db, github, now: () => 4_000 }, REPO, 99)).toBe("UNKNOWN");
    expect(getDivergenceState(db, REPO, 99)?.state).toBe("UNKNOWN");
  });
});

describe("parseEpicFromHeadRef", () => {
  test("parses `middle-issue-<N>` to the integer N", () => {
    expect(parseEpicFromHeadRef("middle-issue-32")).toBe(32);
    expect(parseEpicFromHeadRef("middle-issue-1")).toBe(1);
    expect(parseEpicFromHeadRef("middle-issue-12345")).toBe(12345);
  });

  test("a non-managed head ref → null (the helper skips it)", () => {
    expect(parseEpicFromHeadRef("feature/foo")).toBe(null);
    expect(parseEpicFromHeadRef("main")).toBe(null);
    expect(parseEpicFromHeadRef("")).toBe(null);
  });

  test("a malformed managed ref → null (defends against an inadvertent rename)", () => {
    expect(parseEpicFromHeadRef("middle-issue-")).toBe(null);
    expect(parseEpicFromHeadRef("middle-issue-abc")).toBe(null);
    expect(parseEpicFromHeadRef("middle-issue-32.5")).toBe(null);
    // Negative / zero are not valid Epic numbers (issue numbers start at 1).
    expect(parseEpicFromHeadRef("middle-issue-0")).toBe(null);
    expect(parseEpicFromHeadRef("middle-issue--1")).toBe(null);
  });
});

describe("worktreePathFor", () => {
  test("uses <root>/<repo>/issue-<n> — the same layout createWorktree writes", () => {
    expect(worktreePathFor("owner/repo", 32, "/wt-root")).toBe("/wt-root/owner/repo/issue-32");
  });
});

describe("recordDivergenceState", () => {
  test("accepts terminal-ish states (DEMOTED, SKIPPED) written by sibling phases", () => {
    recordDivergenceState(db, REPO, 90, "DEMOTED", 100);
    expect(getDivergenceState(db, REPO, 90)).toEqual({ state: "DEMOTED", classifiedAt: 100 });

    recordDivergenceState(db, REPO, 91, "SKIPPED", 200);
    expect(getDivergenceState(db, REPO, 91)).toEqual({ state: "SKIPPED", classifiedAt: 200 });
  });

  test("the CHECK constraint rejects an out-of-vocabulary state — defends against a reconciler typo", () => {
    expect(() => {
      recordDivergenceState(db, REPO, 90, "BUSTED" as unknown as "CLEAN", 100);
    }).toThrow();
  });

  test("the (repo, pr_number) PK lets the same pr_number coexist across repos", () => {
    recordDivergenceState(db, "owner-a/r", 90, "CLEAN", 100);
    recordDivergenceState(db, "owner-b/r", 90, "BEHIND", 200);
    expect(getDivergenceState(db, "owner-a/r", 90)?.state).toBe("CLEAN");
    expect(getDivergenceState(db, "owner-b/r", 90)?.state).toBe("BEHIND");
  });
});

/**
 * Build an `ApplyDemoteGateway` spy that records every call (so the test can
 * assert exact call counts across consecutive invocations) and threads a
 * settable `isDraft` for the PR — flipping it on the first call models how
 * GitHub responds on the second.
 */
type DemoteSpy = {
  gateway: ApplyDemoteGateway;
  state: {
    isDraft: boolean;
    headRef: string | null;
    /** Comments per issue/Epic ref, keyed by the string ref. */
    comments: Map<string, string[]>;
    closedSubs: ClosedSubIssue[];
  };
  calls: {
    convertPrToDraft: Array<[string, number]>;
    reopenIssue: Array<{ repo: string; issueNumber: number; comment: string | undefined }>;
    listClosedSubIssues: Array<[string, number]>;
    postComment: Array<{ repo: string; ref: string; body: string }>;
  };
};

function makeDemoteSpy(over: Partial<DemoteSpy["state"]> = {}): DemoteSpy {
  const state: DemoteSpy["state"] = {
    isDraft: false,
    headRef: "middle-issue-32",
    comments: new Map(),
    closedSubs: [{ number: 50, closedAt: 1_700_000_000_000 }],
    ...over,
  };
  const calls: DemoteSpy["calls"] = {
    convertPrToDraft: [],
    reopenIssue: [],
    listClosedSubIssues: [],
    postComment: [],
  };
  const gateway: ApplyDemoteGateway = {
    async getPrHeadRef() {
      return state.headRef;
    },
    async getPullRequest() {
      return { isDraft: state.isDraft };
    },
    async convertPrToDraft(repo, prNumber) {
      calls.convertPrToDraft.push([repo, prNumber]);
      state.isDraft = true; // model the live PR flipping
    },
    async listClosedSubIssues(repo, epicNumber) {
      calls.listClosedSubIssues.push([repo, epicNumber]);
      return state.closedSubs;
    },
    async reopenIssue(repo, issueNumber, options) {
      calls.reopenIssue.push({ repo, issueNumber, comment: options?.comment });
    },
    async listIssueComments(_repo, ref) {
      return (state.comments.get(ref) ?? []).map((body) => ({ body }));
    },
    async postComment(repo, ref, body) {
      calls.postComment.push({ repo, ref, body });
      const bucket = state.comments.get(ref) ?? [];
      bucket.push(body);
      state.comments.set(ref, bucket);
    },
  };
  return { gateway, state, calls };
}

describe("applyDemoteToWork", () => {
  test("flips PR draft, reopens sub-issue, posts dual-surface comment, re-enqueues, state→DEMOTED", async () => {
    const spy = makeDemoteSpy();
    const enqueues: Array<[string, number]> = [];
    await applyDemoteToWork(
      {
        db,
        github: spy.gateway,
        enqueueEpic: async (r, e) => {
          enqueues.push([r, e]);
        },
        now: () => 1_700_000_100_000,
      },
      REPO,
      99,
      ["packages/dispatcher/src/main.ts", "docs/README.md"],
    );

    expect(spy.calls.convertPrToDraft).toEqual([[REPO, 99]]);
    expect(spy.calls.reopenIssue.length).toBe(1);
    expect(spy.calls.reopenIssue[0]?.issueNumber).toBe(50);
    expect(spy.calls.reopenIssue[0]?.comment).toContain("PR #99 for Epic #32");
    expect(spy.calls.postComment.length).toBe(2);
    // Dual surface: one on the PR (99) and one on the Epic (32 — derived from head ref).
    expect(new Set(spy.calls.postComment.map((c) => c.ref))).toEqual(new Set(["99", "32"]));
    // Conflicting paths are surfaced in the escalation body.
    for (const post of spy.calls.postComment) {
      expect(post.body).toContain("packages/dispatcher/src/main.ts");
      expect(post.body).toContain("docs/README.md");
      expect(post.body).toContain("<!-- middle-divergence-demoted: 32 -->");
    }
    expect(enqueues).toEqual([[REPO, 32]]);
    expect(getDivergenceState(db, REPO, 99)).toEqual({
      state: "DEMOTED",
      classifiedAt: 1_700_000_100_000,
    });
  });

  test("per-step idempotency: a second call skips draft-flip + reopen + comments via markers (but still re-enqueues)", async () => {
    // After the first call lands, the second call must NOT pile on duplicates
    // for the steps gated by GitHub state (draft flip, sub-issue reopen, both
    // surfaces' escalation comments). Re-enqueue still fires on every pass —
    // it's the recommender's "fresh divergence" nudge and is itself idempotent
    // at the daemon (existing-workflow guard), per the function's contract.
    const spy = makeDemoteSpy();
    const enqueues: Array<[string, number]> = [];
    const deps = {
      db,
      github: spy.gateway,
      enqueueEpic: async (r: string, e: number) => {
        enqueues.push([r, e]);
      },
      now: () => 100,
    };

    await applyDemoteToWork(deps, REPO, 99, ["a.txt"]);
    await applyDemoteToWork(deps, REPO, 99, ["a.txt"]); // second call

    // Marker-gated steps fired exactly once across two calls.
    expect(spy.calls.convertPrToDraft.length).toBe(1);
    expect(spy.calls.reopenIssue.length).toBe(1);
    expect(spy.calls.postComment.length).toBe(2);
    // Re-enqueue fires every pass — docstring contract.
    expect(enqueues.length).toBe(2);
  });

  test("partial-retry: prior attempt left the PR drafted but did not reopen / comment / enqueue — second pass completes remediation", async () => {
    // Models a crash between `convertPrToDraft` and the next step on the first
    // attempt: GitHub already sees the PR as a draft, but our spy's state shows
    // no reopen, no comments, no enqueue, no row. The second pass must NOT
    // short-circuit on `pr.isDraft` (the pre-fix behaviour) — it must finish
    // every remaining remediation step.
    const spy = makeDemoteSpy({ isDraft: true });
    const enqueues: Array<[string, number]> = [];
    await applyDemoteToWork(
      {
        db,
        github: spy.gateway,
        enqueueEpic: async (r, e) => {
          enqueues.push([r, e]);
        },
        now: () => 1_700_000_200_000,
      },
      REPO,
      99,
      ["packages/x.ts"],
    );

    // The draft-flip step was skipped — the PR was already draft.
    expect(spy.calls.convertPrToDraft).toEqual([]);
    // …but every downstream step ran to completion.
    expect(spy.calls.reopenIssue.length).toBe(1);
    expect(spy.calls.reopenIssue[0]?.issueNumber).toBe(50);
    expect(spy.calls.postComment.length).toBe(2);
    expect(new Set(spy.calls.postComment.map((c) => c.ref))).toEqual(new Set(["99", "32"]));
    expect(enqueues).toEqual([[REPO, 32]]);
    expect(getDivergenceState(db, REPO, 99)?.state).toBe("DEMOTED");
  });

  test("partial-retry safety: existing marker on PR skips the duplicate PR comment, still posts on Epic", async () => {
    // Simulate a crash after PR draft + PR comment but before Epic comment. On
    // retry, the PR's marker is found and skipped; the Epic still needs the post.
    // To trigger that path we keep PR.isDraft=false (so the function proceeds)
    // and pre-seed the PR's comments with the marker.
    const spy = makeDemoteSpy({
      comments: new Map([["99", ["…earlier escalation… <!-- middle-divergence-demoted: 32 -->"]]]),
    });
    await applyDemoteToWork(
      {
        db,
        github: spy.gateway,
        enqueueEpic: async () => {},
        now: () => 100,
      },
      REPO,
      99,
      ["x"],
    );
    // Only the Epic comment posts — the PR's existing marker gates the duplicate.
    expect(spy.calls.postComment.length).toBe(1);
    expect(spy.calls.postComment[0]?.ref).toBe("32");
  });

  test("Epic with no closed sub-issues: still demotes + comments + enqueues; no reopen call", async () => {
    const spy = makeDemoteSpy({ closedSubs: [] });
    const enqueues: Array<[string, number]> = [];
    await applyDemoteToWork(
      {
        db,
        github: spy.gateway,
        enqueueEpic: async (r, e) => {
          enqueues.push([r, e]);
        },
        now: () => 100,
      },
      REPO,
      99,
      ["x"],
    );
    expect(spy.calls.reopenIssue.length).toBe(0);
    expect(spy.calls.convertPrToDraft.length).toBe(1);
    expect(spy.calls.postComment.length).toBe(2);
    expect(enqueues.length).toBe(1);
  });

  test("non-managed head ref → no-op (no draft, no comments, no enqueue, no row)", async () => {
    const spy = makeDemoteSpy({ headRef: "feature/random" });
    const enqueues: Array<[string, number]> = [];
    await applyDemoteToWork(
      {
        db,
        github: spy.gateway,
        enqueueEpic: async (r, e) => {
          enqueues.push([r, e]);
        },
      },
      REPO,
      99,
      ["x"],
    );
    expect(spy.calls.convertPrToDraft).toEqual([]);
    expect(spy.calls.postComment).toEqual([]);
    expect(enqueues).toEqual([]);
    expect(getDivergenceState(db, REPO, 99)).toBe(null);
  });

  test("manual recovery: an Epic that already carries the demote marker skips the reopen call (self-review hardening)", async () => {
    // Scenario: prior demote landed → marker on Epic 32. Human reviewed,
    // manually fixed conflicts, marked PR ready, closed the reopened sub-issue.
    // Now a fresh divergence emerges and reconciler runs applyDemoteToWork.
    // PR.isDraft = false (human marked ready), so the early-exit doesn't fire,
    // but the Epic-marker gate must suppress the reopen so the human's manual
    // sub-issue close isn't undone.
    const spy = makeDemoteSpy({
      comments: new Map([
        ["32", ["…earlier demote escalation… <!-- middle-divergence-demoted: 32 -->"]],
      ]),
    });
    const enqueues: Array<[string, number]> = [];
    await applyDemoteToWork(
      {
        db,
        github: spy.gateway,
        enqueueEpic: async (r, e) => {
          enqueues.push([r, e]);
        },
        now: () => 100,
      },
      REPO,
      99,
      ["x"],
    );

    // PR is re-drafted + state→DEMOTED + Epic is re-enqueued (all expected on a
    // fresh divergence) — but reopenIssue must NOT fire (the marker says we
    // already escalated this Epic; don't fight the human's manual recovery).
    expect(spy.calls.convertPrToDraft).toEqual([[REPO, 99]]);
    expect(spy.calls.reopenIssue).toEqual([]);
    expect(enqueues).toEqual([[REPO, 32]]);
    expect(getDivergenceState(db, REPO, 99)?.state).toBe("DEMOTED");
    // The marker on the Epic also gates the duplicate Epic comment — only PR
    // gets a fresh comment (its marker is absent).
    expect(new Set(spy.calls.postComment.map((c) => c.ref))).toEqual(new Set(["99"]));
  });

  test("a supplied reason (#201 data-loss) replaces the conflict narrative in the escalation comment", async () => {
    const spy = makeDemoteSpy();
    const reason =
      "A `git rebase origin/main` dropped **all** of the PR's commits — investigate manually.";
    await applyDemoteToWork(
      {
        db,
        github: spy.gateway,
        enqueueEpic: async () => {},
        now: () => 100,
      },
      REPO,
      99,
      [], // no conflicting paths — this isn't a conflict
      { reason },
    );
    expect(spy.calls.postComment.length).toBe(2);
    for (const post of spy.calls.postComment) {
      // The specific reason is present…
      expect(post.body).toContain("dropped **all** of the PR's commits");
      // …and the default "Both autonomous attempts failed" narrative is NOT.
      expect(post.body).not.toContain("Both autonomous attempts failed");
      // The escalation still flips to draft + reopens (the standard remediation).
      expect(post.body).toContain("flipped back to **draft**");
      expect(post.body).toContain("<!-- middle-divergence-demoted: 32 -->");
    }
    // Standard demote side effects still occur.
    expect(spy.calls.convertPrToDraft).toEqual([[REPO, 99]]);
    expect(spy.calls.reopenIssue.length).toBe(1);
    expect(getDivergenceState(db, REPO, 99)?.state).toBe("DEMOTED");
  });

  test("PR doesn't exist (gateway returns null) → no-op", async () => {
    const spy = makeDemoteSpy();
    // Override getPullRequest to return null.
    const gateway = {
      ...spy.gateway,
      getPullRequest: async () => null,
    };
    await applyDemoteToWork(
      {
        db,
        github: gateway,
        enqueueEpic: async () => {},
      },
      REPO,
      99,
      ["x"],
    );
    expect(spy.calls.convertPrToDraft).toEqual([]);
    expect(spy.calls.postComment).toEqual([]);
  });
});

describe("ghStderrIsNotFound", () => {
  // The not-found shapes the production gateway's `getMergeability` /
  // `getPrHeadRef` / `getPullRequest` / `getMainCommitSha` recognize as "PR or
  // branch doesn't exist → null". Anything else must throw so the orchestrator's
  // per-PR try/catch surfaces transport/auth/rate-limit failures as `failed++`
  // instead of silently passing the PR through as UNKNOWN.
  for (const stderr of [
    "Could not resolve to a PullRequest with the number 99.",
    "Could not resolve to a Branch with the name 'main'.",
    "HTTP 404: Not Found (https://api.github.com/...)",
    "graphql: Could not resolve to a Repository",
  ]) {
    test(`recognizes not-found: ${JSON.stringify(stderr.slice(0, 40))}`, () => {
      expect(ghStderrIsNotFound(stderr)).toBe(true);
    });
  }

  for (const stderr of [
    "error connecting to api.github.com: dial tcp: connection refused",
    "HTTP 401: Bad credentials",
    "HTTP 403: API rate limit exceeded",
    "HTTP 502: Bad Gateway",
    "gh: command failed (oauth token expired)",
    "could not deserialize response", // close-but-not — must NOT be treated as 404
    "remote: secret not found, push declined", // push-protection: NOT a 404
    "Not Found", // bare phrase alone — too ambiguous; require an `HTTP 404` or `Could not resolve` prefix
    "",
  ]) {
    test(`treats non-404 failure as throw-worthy: ${JSON.stringify(stderr.slice(0, 40))}`, () => {
      expect(ghStderrIsNotFound(stderr)).toBe(false);
    });
  }
});
