import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAndMigrate } from "../src/db.ts";
import { formatPauseComment } from "../src/build-deps.ts";
import {
  AGENT_COMMENT_MARKER,
  CI_PENDING_ESCALATION_WINDOW_MS,
  classifyNewHumanReply,
  classifyReviewOutcome,
  isCiPendingEscalation,
  reasonFromSignalName,
  runPoller,
  type PollGateway,
  type IssueComment,
  type PrSnapshot,
  type RateLimitStatus,
  type ResumeSignalPayload,
} from "../src/poller.ts";
import {
  armWaitForSignal,
  createWorkflowRecord,
  getWaitForSignal,
  updateWorkflow,
} from "../src/workflow-record.ts";
import { signalNameFor, type ResumeReason } from "../src/workflows/implementation.ts";

let scratch: string;
let db: Database;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "middle-poll-"));
  db = openAndMigrate(join(scratch, "db.sqlite3"));
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const REPO = "thejustinwalsh/middle";
const EPIC = 32;
const ARMED_AT = 1_000_000;

/** Seed a parked workflow with an armed wait for `reason`, armed at ARMED_AT. */
function seedParked(reason: ResumeReason, epic = EPIC): string {
  const id = crypto.randomUUID();
  createWorkflowRecord(db, {
    id,
    kind: "implementation",
    repo: REPO,
    epicRef: String(epic),
    adapter: "claude",
  });
  updateWorkflow(db, id, { state: "waiting-human" });
  // armWaitForSignal stamps created_at = Date.now(); normalize it to ARMED_AT so
  // recency comparisons in the poller are deterministic.
  armWaitForSignal(db, signalNameFor(String(epic), reason), id, JSON.stringify({ reason }));
  db.run("UPDATE waitfor_signals SET created_at = ? WHERE workflow_id = ?", [ARMED_AT, id]);
  return id;
}

function comment(over: Partial<IssueComment>): IssueComment {
  return {
    id: 1,
    authorLogin: "octocat",
    authorIsBot: false,
    createdAt: ARMED_AT + 1000,
    body: "hi",
    ...over,
  };
}

function prSnapshot(over: Partial<PrSnapshot>): PrSnapshot {
  return { number: 90, reviewDecision: null, reviews: [], labels: [], ...over };
}

/** A gateway stub returning fixed comments / PR snapshot, recording calls. */
function makeGateway(opts: {
  comments?: IssueComment[];
  pr?: PrSnapshot | null;
  rateLimit?: RateLimitStatus;
}): PollGateway & { commentCalls: number; prCalls: number; rateLimitCalls: number } {
  const g = {
    commentCalls: 0,
    prCalls: 0,
    rateLimitCalls: 0,
    async listIssueComments() {
      g.commentCalls++;
      return opts.comments ?? [];
    },
    async findPrForEpic() {
      g.prCalls++;
      return opts.pr ?? null;
    },
    async findEpicPrLifecycle() {
      return null; // these tests exercise the resume poller, not reconciliation
    },
    async prSnapshot() {
      g.prCalls++;
      return opts.pr ?? null;
    },
    async prLifecycle() {
      return null;
    },
    async getRateLimit() {
      g.rateLimitCalls++;
      return opts.rateLimit ?? { remaining: 5000, resetAt: 0 };
    },
  };
  return g;
}

function captureFires(): {
  fired: Array<{ workflowId: string; payload: ResumeSignalPayload }>;
  fireSignal: (id: string, p: ResumeSignalPayload) => Promise<void>;
} {
  const fired: Array<{ workflowId: string; payload: ResumeSignalPayload }> = [];
  return {
    fired,
    fireSignal: async (workflowId, payload) => {
      fired.push({ workflowId, payload });
    },
  };
}

describe("reasonFromSignalName", () => {
  test("maps the durable signal names to resume reasons", () => {
    expect(reasonFromSignalName("epic-32-answered")).toBe("answered-question");
    expect(reasonFromSignalName("epic-32-review-resolved")).toBe("review-changes");
    expect(reasonFromSignalName("blocked:wf_123")).toBe("answered-question");
    expect(reasonFromSignalName("something-else")).toBeNull();
  });
});

describe("classifyNewHumanReply", () => {
  test("returns the newest non-bot reply posted after the wait armed", () => {
    const reply = classifyNewHumanReply(
      [
        comment({ id: 1, createdAt: ARMED_AT + 100, body: "first" }),
        comment({ id: 2, createdAt: ARMED_AT + 500, body: "newest" }),
        comment({ id: 3, authorIsBot: true, createdAt: ARMED_AT + 900, body: "bot noise" }),
        comment({ id: 4, createdAt: ARMED_AT - 100, body: "stale (pre-armed)" }),
      ],
      ARMED_AT,
    );
    expect(reply?.id).toBe(2);
    expect(reply?.body).toBe("newest");
  });

  test("returns null when only bot/stale comments exist", () => {
    expect(
      classifyNewHumanReply(
        [
          comment({ authorIsBot: true, createdAt: ARMED_AT + 100 }),
          comment({ createdAt: ARMED_AT - 1 }),
        ],
        ARMED_AT,
      ),
    ).toBeNull();
  });

  test("skips the dispatcher's own marked pause comment (posted as a non-bot human identity)", () => {
    // The real formatPauseComment output — the exact body the dispatcher posts.
    const pause = formatPauseComment({ question: "Which option?", kind: "question" });
    expect(pause.startsWith(AGENT_COMMENT_MARKER)).toBe(true);
    expect(
      classifyNewHumanReply(
        [comment({ id: 1, authorIsBot: false, createdAt: ARMED_AT + 100, body: pause })],
        ARMED_AT,
      ),
    ).toBeNull();
  });

  test("a genuine human reply that quote-replies the pause comment still resumes", () => {
    // GitHub "Quote reply" copies the marker into the body, but on a quoted
    // (non-leading) line — so the real answer below it must NOT be skipped.
    const quoted = `> ${AGENT_COMMENT_MARKER}\n> 🙋 **agent question**\n\nGo with option B.`;
    const reply = classifyNewHumanReply(
      [comment({ id: 9, authorLogin: "maintainer", createdAt: ARMED_AT + 100, body: quoted })],
      ARMED_AT,
    );
    expect(reply?.id).toBe(9);
    expect(reply?.body).toContain("Go with option B.");
  });
});

describe("classifyReviewOutcome", () => {
  test("a fresh CHANGES_REQUESTED review → changes-requested", () => {
    const v = classifyReviewOutcome(
      prSnapshot({
        reviewDecision: "CHANGES_REQUESTED",
        reviews: [
          {
            id: 7,
            state: "CHANGES_REQUESTED",
            authorLogin: "coderabbitai[bot]",
            submittedAt: ARMED_AT + 10,
            body: "Actionable comments posted: 3",
          },
        ],
      }),
      ARMED_AT,
    );
    expect(v).toEqual({ outcome: "changes-requested", reviewId: 7, decision: "CHANGES_REQUESTED" });
  });

  test("a fresh APPROVED review → resolved", () => {
    const v = classifyReviewOutcome(
      prSnapshot({
        reviewDecision: "APPROVED",
        reviews: [
          {
            id: 8,
            state: "APPROVED",
            authorLogin: "human",
            submittedAt: ARMED_AT + 10,
            body: "lgtm",
          },
        ],
      }),
      ARMED_AT,
    );
    expect(v).toEqual({ outcome: "resolved", reviewId: 8, decision: "APPROVED" });
  });

  test("a fresh 0-actionable re-review → resolved even while decision stays CHANGES_REQUESTED", () => {
    const v = classifyReviewOutcome(
      prSnapshot({
        reviewDecision: "CHANGES_REQUESTED", // bot didn't flip its standing verdict
        reviews: [
          {
            id: 9,
            state: "COMMENTED",
            authorLogin: "coderabbitai[bot]",
            submittedAt: ARMED_AT + 10,
            body: "**Actionable comments posted: 0**\n\nLooks good.",
          },
        ],
      }),
      ARMED_AT,
    );
    expect(v).toEqual({ outcome: "resolved", reviewId: 9, decision: "CHANGES_REQUESTED" });
  });

  test("the `changes-requested` label alone (no fresh review) → changes-requested", () => {
    const v = classifyReviewOutcome(prSnapshot({ labels: ["changes-requested"] }), ARMED_AT);
    expect(v).toEqual({
      outcome: "changes-requested",
      reviewId: null,
      decision: "CHANGES_REQUESTED",
    });
  });

  test("only stale reviews and no actionable label → null (nothing changed)", () => {
    // Review is 6 minutes before arm — outside the 5-minute slack window.
    const v = classifyReviewOutcome(
      prSnapshot({
        reviews: [
          {
            id: 1,
            state: "CHANGES_REQUESTED",
            authorLogin: "x",
            submittedAt: ARMED_AT - 6 * 60 * 1000,
            body: "old",
          },
        ],
      }),
      ARMED_AT,
    );
    expect(v).toBeNull();
  });

  test("CHANGES_REQUESTED review posted just before arm (within slack) is treated as fresh", () => {
    // CodeRabbit can post within seconds of a push; the drive pipeline takes
    // 30-120s to arm, so the review can land before the arm timestamp. The
    // 5-minute slack window catches these fast reviews so the PR doesn't sit
    // in waiting-human forever.
    const v = classifyReviewOutcome(
      prSnapshot({
        reviewDecision: "CHANGES_REQUESTED",
        reviews: [
          {
            id: 42,
            state: "CHANGES_REQUESTED",
            authorLogin: "coderabbitai[bot]",
            submittedAt: ARMED_AT - 10_000, // 10 seconds before arm, within 5-min slack
            body: "Actionable comments posted: 3",
          },
        ],
      }),
      ARMED_AT,
    );
    expect(v).toEqual({
      outcome: "changes-requested",
      reviewId: 42,
      decision: "CHANGES_REQUESTED",
    });
  });

  test("a stale standing CHANGES_REQUESTED decision (no fresh review, no label) → null", () => {
    // A bot reviewer leaves the PR's standing decision at CHANGES_REQUESTED even
    // after the agent addressed it, so the standing decision alone must NOT
    // re-fire a resume every pass — only a fresh review or an explicit label does.
    const v = classifyReviewOutcome(prSnapshot({ reviewDecision: "CHANGES_REQUESTED" }), ARMED_AT);
    expect(v).toBeNull();
  });
});

describe("classifyReviewOutcome — CI gate", () => {
  test("failing CI with no review feedback → resume to fix CI (CI_FAILED)", () => {
    const v = classifyReviewOutcome(prSnapshot({ ci: "failing" }), ARMED_AT);
    expect(v).toEqual({ outcome: "changes-requested", reviewId: null, decision: "CI_FAILED" });
  });

  test("an APPROVED review while CI is still pending is held (null) — don't end on un-built CI", () => {
    const v = classifyReviewOutcome(
      prSnapshot({ reviewDecision: "APPROVED", ci: "pending" }),
      ARMED_AT,
    );
    expect(v).toBeNull();
  });

  test("an APPROVED review with passing CI resolves", () => {
    const v = classifyReviewOutcome(
      prSnapshot({ reviewDecision: "APPROVED", ci: "passing" }),
      ARMED_AT,
    );
    expect(v).toEqual({ outcome: "resolved", reviewId: null, decision: "APPROVED" });
  });

  test("explicit review feedback wins over red CI (address the review, which greens CI)", () => {
    const v = classifyReviewOutcome(
      prSnapshot({ labels: ["changes-requested"], ci: "failing" }),
      ARMED_AT,
    );
    expect(v).toEqual({
      outcome: "changes-requested",
      reviewId: null,
      decision: "CHANGES_REQUESTED",
    });
  });

  test("absent CI (`none`) is non-blocking — the pre-CI review loop is unchanged", () => {
    const v = classifyReviewOutcome(prSnapshot({ reviewDecision: "APPROVED" }), ARMED_AT);
    expect(v).toEqual({ outcome: "resolved", reviewId: null, decision: "APPROVED" });
  });

  test("failing CI but no PR change and no review → still CI_FAILED (red build is actionable)", () => {
    const v = classifyReviewOutcome(prSnapshot({ ci: "failing", reviewDecision: null }), ARMED_AT);
    expect(v?.decision).toBe("CI_FAILED");
  });
});

describe("runPoller — answered-question", () => {
  test("a new human reply fires epic-<n>-answered exactly once (idempotent across passes)", async () => {
    const id = seedParked("answered-question");
    const github = makeGateway({
      comments: [comment({ id: 42, authorLogin: "maintainer", body: "Go with option B." })],
    });
    const { fired, fireSignal } = captureFires();

    expect(await runPoller({ db, github, fireSignal, now: () => ARMED_AT + 5000 })).toBe(1);
    expect(fired).toEqual([
      {
        workflowId: id,
        payload: {
          reason: "answered-question",
          reply: { commentId: 42, authorLogin: "maintainer", body: "Go with option B." },
        },
      },
    ]);

    // Second pass must NOT re-fire (fired_at guards it).
    expect(await runPoller({ db, github, fireSignal, now: () => ARMED_AT + 9000 })).toBe(0);
    expect(fired.length).toBe(1);
  });

  test("a bot-only reply does not fire", async () => {
    seedParked("answered-question");
    const github = makeGateway({
      comments: [comment({ id: 1, authorLogin: "coderabbitai[bot]", authorIsBot: true })],
    });
    const { fired, fireSignal } = captureFires();
    expect(await runPoller({ db, github, fireSignal, now: () => ARMED_AT + 5000 })).toBe(0);
    expect(fired).toEqual([]);
  });

  test("the dispatcher's own pause comment does not self-resume (#178)", async () => {
    seedParked("answered-question");
    // The exact comment the dispatcher posts on park, under its human gh identity.
    const github = makeGateway({
      comments: [
        comment({
          id: 1,
          authorLogin: "thejustinwalsh",
          authorIsBot: false,
          createdAt: ARMED_AT + 100,
          body: formatPauseComment({ question: "Which adapter?", kind: "question" }),
        }),
      ],
    });
    const { fired, fireSignal } = captureFires();
    expect(await runPoller({ db, github, fireSignal, now: () => ARMED_AT + 5000 })).toBe(0);
    expect(fired).toEqual([]);
  });
});

describe("runPoller — review-changes", () => {
  test("CHANGES_REQUESTED fires review-resolved with outcome 'changes-requested'", async () => {
    const id = seedParked("review-changes");
    const github = makeGateway({
      pr: prSnapshot({
        reviewDecision: "CHANGES_REQUESTED",
        reviews: [
          {
            id: 7,
            state: "CHANGES_REQUESTED",
            authorLogin: "coderabbitai[bot]",
            submittedAt: ARMED_AT + 10,
            body: "Actionable comments posted: 2",
          },
        ],
      }),
    });
    const { fired, fireSignal } = captureFires();
    expect(await runPoller({ db, github, fireSignal, now: () => ARMED_AT + 5000 })).toBe(1);
    expect(fired[0]).toEqual({
      workflowId: id,
      payload: {
        reason: "review-changes",
        outcome: "changes-requested",
        reviewId: 7,
        decision: "CHANGES_REQUESTED",
      },
    });
  });

  test("APPROVED fires review-resolved as resolved", async () => {
    seedParked("review-changes");
    const github = makeGateway({
      pr: prSnapshot({
        reviewDecision: "APPROVED",
        reviews: [
          {
            id: 8,
            state: "APPROVED",
            authorLogin: "human",
            submittedAt: ARMED_AT + 10,
            body: "ship it",
          },
        ],
      }),
    });
    const { fired, fireSignal } = captureFires();
    expect(await runPoller({ db, github, fireSignal, now: () => ARMED_AT + 5000 })).toBe(1);
    expect(fired[0]!.payload).toEqual({
      reason: "review-changes",
      outcome: "resolved",
      reviewId: 8,
      decision: "APPROVED",
    });
  });

  test("a 0-actionable re-review fires review-resolved as resolved", async () => {
    seedParked("review-changes");
    const github = makeGateway({
      pr: prSnapshot({
        reviewDecision: "CHANGES_REQUESTED",
        reviews: [
          {
            id: 9,
            state: "COMMENTED",
            authorLogin: "coderabbitai[bot]",
            submittedAt: ARMED_AT + 10,
            body: "**Actionable comments posted: 0**",
          },
        ],
      }),
    });
    const { fired, fireSignal } = captureFires();
    expect(await runPoller({ db, github, fireSignal, now: () => ARMED_AT + 5000 })).toBe(1);
    expect(fired[0]!.payload).toMatchObject({ reason: "review-changes", outcome: "resolved" });
  });

  test("no PR yet → no fire", async () => {
    seedParked("review-changes");
    const github = makeGateway({ pr: null });
    const { fired, fireSignal } = captureFires();
    expect(await runPoller({ db, github, fireSignal, now: () => ARMED_AT + 5000 })).toBe(0);
    expect(fired).toEqual([]);
  });
});

describe("runPoller — resilience", () => {
  test("a gateway error for one workflow is isolated; others still fire", async () => {
    const good = seedParked("answered-question", 100);
    seedParked("answered-question", 200); // this one's gateway throws

    let n = 0;
    const github: PollGateway = {
      async listIssueComments(_repo, epicRef) {
        n++;
        if (epicRef === "200") throw new Error("API rate limit exceeded");
        return [comment({ id: 1, authorLogin: "human", body: "answer" })];
      },
      async findPrForEpic() {
        return null;
      },
      async findEpicPrLifecycle() {
        return null;
      },
      async prSnapshot() {
        return null;
      },
      async prLifecycle() {
        return null;
      },
      async getRateLimit() {
        return { remaining: 5000, resetAt: 0 };
      },
    };
    const { fired, fireSignal } = captureFires();
    // One fires, one throws-and-is-skipped — the pass still completes.
    expect(await runPoller({ db, github, fireSignal, now: () => ARMED_AT + 5000 })).toBe(1);
    expect(n).toBe(2);
    expect(fired.map((f) => f.workflowId)).toEqual([good]);
    expect(getWaitForSignal(db, good)).not.toBeNull(); // row still present until resume consumes it
  });
});

describe("runPoller — GitHub rate-limit guards", () => {
  test("skips the whole pass when remaining budget is below the buffer", async () => {
    seedParked("answered-question"); // a fresh human reply is ready → would fire
    const github = makeGateway({
      comments: [
        comment({ id: 1, authorLogin: "human", body: "answer", createdAt: ARMED_AT + 100 }),
      ],
      rateLimit: { remaining: 50, resetAt: ARMED_AT + 60_000 },
    });
    const { fired, fireSignal } = captureFires();
    // buffer defaults to 100; 50 < 100 → skip the pass before any per-workflow call.
    expect(await runPoller({ db, github, fireSignal, now: () => ARMED_AT + 5000 })).toBe(0);
    expect(github.rateLimitCalls).toBe(1); // it checked the budget
    expect(github.commentCalls).toBe(0); // …and made no workflow calls
    expect(fired).toEqual([]);
  });

  test("a healthy budget proceeds (the guard isn't always-on)", async () => {
    seedParked("answered-question");
    const github = makeGateway({
      comments: [
        comment({ id: 1, authorLogin: "human", body: "answer", createdAt: ARMED_AT + 100 }),
      ],
      rateLimit: { remaining: 4999, resetAt: 0 },
    });
    const { fired, fireSignal } = captureFires();
    expect(await runPoller({ db, github, fireSignal, now: () => ARMED_AT + 5000 })).toBe(1);
    expect(github.commentCalls).toBe(1);
    expect(fired.length).toBe(1);
  });

  test("caps the workflows polled per pass (burst protection)", async () => {
    seedParked("answered-question", 100);
    seedParked("answered-question", 200);
    seedParked("answered-question", 300);
    const github = makeGateway({
      comments: [
        comment({ id: 1, authorLogin: "human", body: "answer", createdAt: ARMED_AT + 100 }),
      ],
    });
    const { fired, fireSignal } = captureFires();
    // 3 actionable waits, cap 2 → only 2 polled this pass; the rest wait for next.
    expect(
      await runPoller({ db, github, fireSignal, now: () => ARMED_AT + 5000, maxPollsPerPass: 2 }),
    ).toBe(2);
    expect(github.commentCalls).toBe(2);
    expect(fired.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// #262 — CI-forever-pending escalation
// ---------------------------------------------------------------------------

describe("isCiPendingEscalation — threshold check (#262)", () => {
  test("below the 48h window → false (hold is too fresh to escalate)", () => {
    // holdCreatedAt = ARMED_AT, now = ARMED_AT + 1h (well within the 48h window)
    expect(isCiPendingEscalation(ARMED_AT, ARMED_AT + 60 * 60 * 1000)).toBe(false);
  });

  test("past the 48h window → true (escalate)", () => {
    // holdCreatedAt = ARMED_AT, now = ARMED_AT + 49h (past threshold)
    const past = ARMED_AT + CI_PENDING_ESCALATION_WINDOW_MS + 60_000;
    expect(isCiPendingEscalation(ARMED_AT, past)).toBe(true);
  });

  test("exactly at the threshold boundary → false (not yet exceeded)", () => {
    expect(isCiPendingEscalation(ARMED_AT, ARMED_AT + CI_PENDING_ESCALATION_WINDOW_MS)).toBe(false);
  });
});

describe("runPoller — CI pending escalation integration (#262)", () => {
  test("approved+pending PR past the threshold triggers escalation comment on the Epic", async () => {
    const id = seedParked("review-changes");
    const postedComments: Array<{ repo: string; ref: string; body: string }> = [];
    const github = makeGateway({
      pr: prSnapshot({ reviewDecision: "APPROVED", ci: "pending" }),
    });
    const { fired, fireSignal } = captureFires();

    // Arm time = ARMED_AT; now = past the 48h escalation window
    const past = ARMED_AT + CI_PENDING_ESCALATION_WINDOW_MS + 60_000;
    await runPoller({
      db,
      github,
      fireSignal,
      now: () => past,
      postEpicComment: async (repo, epicRef, body) => {
        postedComments.push({ repo, ref: epicRef, body });
      },
    });

    // The escalation comment must be posted on the Epic
    expect(postedComments.length).toBe(1);
    expect(postedComments[0]!.ref).toBe(String(EPIC));
    expect(postedComments[0]!.body).toContain("APPROVED");
    expect(postedComments[0]!.body).toContain("pending");
    // The workflow is NOT resumed — escalation is a comment, not a signal fire
    expect(fired.length).toBe(0);
    // The wait remains armed for the next pass
    expect(getWaitForSignal(db, id)).not.toBeNull();
  });

  test("approved+pending PR below the threshold does NOT post escalation comment", async () => {
    seedParked("review-changes");
    const postedComments: string[] = [];
    const github = makeGateway({
      pr: prSnapshot({ reviewDecision: "APPROVED", ci: "pending" }),
    });
    const { fired, fireSignal } = captureFires();

    // Only 1 hour past arm time — well within the 48h window
    await runPoller({
      db,
      github,
      fireSignal,
      now: () => ARMED_AT + 60 * 60 * 1000,
      postEpicComment: async () => {
        postedComments.push("posted");
      },
    });

    expect(postedComments.length).toBe(0);
    expect(fired.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #263 — DISMISSED review verdict
// ---------------------------------------------------------------------------

describe("classifyReviewOutcome — DISMISSED verdict (#263)", () => {
  test("freshest review DISMISSED + reviewDecision no longer CHANGES_REQUESTED → resolved", () => {
    // The reviewer dismissed their CHANGES_REQUESTED; decision flipped to APPROVED
    const v = classifyReviewOutcome(
      prSnapshot({
        reviewDecision: "APPROVED",
        reviews: [
          {
            id: 11,
            state: "DISMISSED",
            authorLogin: "human",
            submittedAt: ARMED_AT + 10,
            body: "",
          },
        ],
      }),
      ARMED_AT,
    );
    expect(v).toEqual({ outcome: "resolved", reviewId: 11, decision: "APPROVED" });
  });

  test("freshest review DISMISSED + reviewDecision still CHANGES_REQUESTED → null (other blockers remain)", () => {
    // The dismiss didn't clear all blockers — another CHANGES_REQUESTED review is standing
    const v = classifyReviewOutcome(
      prSnapshot({
        reviewDecision: "CHANGES_REQUESTED",
        reviews: [
          {
            id: 12,
            state: "DISMISSED",
            authorLogin: "human",
            submittedAt: ARMED_AT + 10,
            body: "",
          },
        ],
      }),
      ARMED_AT,
    );
    expect(v).toBeNull();
  });
});

describe("runPoller — DISMISSED review integration (#263)", () => {
  test("DISMISSED clears last blocker (reviewDecision=APPROVED) → poller fires resolved", async () => {
    seedParked("review-changes");
    const github = makeGateway({
      pr: prSnapshot({
        reviewDecision: "APPROVED",
        reviews: [
          {
            id: 11,
            state: "DISMISSED",
            authorLogin: "human",
            submittedAt: ARMED_AT + 10,
            body: "",
          },
        ],
      }),
    });
    const { fired, fireSignal } = captureFires();
    expect(await runPoller({ db, github, fireSignal, now: () => ARMED_AT + 5000 })).toBe(1);
    expect(fired[0]!.payload).toMatchObject({
      reason: "review-changes",
      outcome: "resolved",
      reviewId: 11,
    });
    // The wait is marked fired so a second pass does not re-fire it.
    expect(await runPoller({ db, github, fireSignal, now: () => ARMED_AT + 5000 })).toBe(0);
    expect(fired.length).toBe(1);
  });

  test("DISMISSED with other blockers (reviewDecision=CHANGES_REQUESTED) → poller does NOT fire", async () => {
    seedParked("review-changes");
    const github = makeGateway({
      pr: prSnapshot({
        reviewDecision: "CHANGES_REQUESTED",
        reviews: [
          {
            id: 12,
            state: "DISMISSED",
            authorLogin: "human",
            submittedAt: ARMED_AT + 10,
            body: "",
          },
        ],
      }),
    });
    const { fired, fireSignal } = captureFires();
    expect(await runPoller({ db, github, fireSignal, now: () => ARMED_AT + 5000 })).toBe(0);
    expect(fired.length).toBe(0);
  });
});
