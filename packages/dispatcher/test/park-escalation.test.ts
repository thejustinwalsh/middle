import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAndMigrate } from "../src/db.ts";
import { AGENT_COMMENT_MARKER } from "../src/poller.ts";
import {
  DEFAULT_PARK_STALENESS_MS,
  isParkStale,
  PARK_ESCALATED_EVENT,
  runParkEscalation,
} from "../src/park-escalation.ts";
import {
  armWaitForSignal,
  createWorkflowRecord,
  getWorkflow,
  hasEventOfType,
  markSignalFired,
  updateWorkflow,
} from "../src/workflow-record.ts";
import {
  signalNameFor,
  WAITFOR_TIMEOUT_MS,
  type ResumeReason,
} from "../src/workflows/implementation.ts";

let scratch: string;
let db: Database;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "middle-park-esc-"));
  db = openAndMigrate(join(scratch, "db.sqlite3"));
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const REPO = "thejustinwalsh/middle";
const EPIC = 42;
const ARMED_AT = 1_000_000;
/** A `now` comfortably past the default 7-day threshold (8 days after arm). */
const STALE_NOW = ARMED_AT + DEFAULT_PARK_STALENESS_MS + 24 * 60 * 60 * 1000;
const WORKTREE = "/tmp/fixture-worktree";

/** Seed a parked workflow with an armed wait for `reason`, armed at `armedAt`. */
function seedParked(
  reason: ResumeReason,
  opts: { epic?: number; armedAt?: number; worktree?: string | null } = {},
): string {
  const epic = opts.epic ?? EPIC;
  const id = crypto.randomUUID();
  createWorkflowRecord(db, {
    id,
    kind: "implementation",
    repo: REPO,
    epicRef: String(epic),
    adapter: "claude",
  });
  updateWorkflow(db, id, { state: "waiting-human", worktreePath: opts.worktree ?? WORKTREE });
  armWaitForSignal(db, signalNameFor(String(epic), reason), id, JSON.stringify({ reason }));
  db.run("UPDATE waitfor_signals SET created_at = ? WHERE workflow_id = ?", [
    opts.armedAt ?? ARMED_AT,
    id,
  ]);
  return id;
}

type Posted = { repo: string; epicRef: string; body: string };

/** A poster stub that records every escalation comment. */
function capturePoster(): {
  posted: Posted[];
  post: NonNullable<Parameters<typeof runParkEscalation>[0]["postEpicComment"]>;
} {
  const posted: Posted[] = [];
  return {
    posted,
    post: async (repo, epicRef, body) => {
      posted.push({ repo, epicRef, body });
    },
  };
}

describe("isParkStale — threshold boundary", () => {
  test("below the threshold is not stale", () => {
    expect(isParkStale(ARMED_AT, ARMED_AT + 60_000, DEFAULT_PARK_STALENESS_MS)).toBe(false);
  });
  test("exactly at the threshold is not stale (strict >)", () => {
    expect(
      isParkStale(ARMED_AT, ARMED_AT + DEFAULT_PARK_STALENESS_MS, DEFAULT_PARK_STALENESS_MS),
    ).toBe(false);
  });
  test("past the threshold is stale", () => {
    expect(
      isParkStale(ARMED_AT, ARMED_AT + DEFAULT_PARK_STALENESS_MS + 1, DEFAULT_PARK_STALENESS_MS),
    ).toBe(true);
  });
});

describe("runParkEscalation — escalates a stale park", () => {
  test("posts comment + records park.escalated event + preserves the worktree", async () => {
    const id = seedParked("answered-question");
    const { posted, post } = capturePoster();

    const n = await runParkEscalation({ db, postEpicComment: post, now: () => STALE_NOW });

    expect(n).toBe(1);
    // (1) escalation comment dispatched to the Epic
    expect(posted).toHaveLength(1);
    expect(posted[0]!.repo).toBe(REPO);
    expect(posted[0]!.epicRef).toBe(String(EPIC));
    expect(posted[0]!.body.startsWith(AGENT_COMMENT_MARKER)).toBe(true);
    expect(posted[0]!.body).toContain("parked for 8 days");
    expect(posted[0]!.body).toContain("a human answer");
    // (2) park.escalated event recorded
    expect(hasEventOfType(db, id, PARK_ESCALATED_EVENT)).toBe(true);
    // (3) worktree preserved: the row is untouched — still parked, same worktree,
    // and never compensated (the pass owns no worktree seam at all).
    const row = getWorkflow(db, id)!;
    expect(row.state).toBe("waiting-human");
    expect(row.worktreePath).toBe(WORKTREE);
  });

  test("review-changes park names the review verdict in the comment", async () => {
    seedParked("review-changes");
    const { posted, post } = capturePoster();
    await runParkEscalation({ db, postEpicComment: post, now: () => STALE_NOW });
    expect(posted[0]!.body).toContain("a PR review verdict");
  });
});

describe("runParkEscalation — idempotency & filtering", () => {
  test("does not re-escalate a park that already has the event (post once)", async () => {
    seedParked("answered-question");
    const { posted, post } = capturePoster();
    await runParkEscalation({ db, postEpicComment: post, now: () => STALE_NOW });
    expect(posted).toHaveLength(1);
    // Second pass: the event is the dedupe key → no second comment.
    const second = await runParkEscalation({ db, postEpicComment: post, now: () => STALE_NOW });
    expect(second).toBe(0);
    expect(posted).toHaveLength(1);
  });

  test("does not escalate a park below the threshold", async () => {
    seedParked("answered-question");
    const { posted, post } = capturePoster();
    const n = await runParkEscalation({
      db,
      postEpicComment: post,
      now: () => ARMED_AT + 60 * 60 * 1000, // 1 hour — fresh
    });
    expect(n).toBe(0);
    expect(posted).toHaveLength(0);
  });

  test("does not escalate a wait whose signal already fired", async () => {
    const id = seedParked("answered-question");
    markSignalFired(db, id, ARMED_AT + 1000);
    const { posted, post } = capturePoster();
    const n = await runParkEscalation({ db, postEpicComment: post, now: () => STALE_NOW });
    expect(n).toBe(0);
    expect(posted).toHaveLength(0);
  });

  test("a custom threshold makes a younger park escalate", async () => {
    seedParked("answered-question");
    const { posted, post } = capturePoster();
    // 2-day-old park with a 1-day threshold → stale.
    const n = await runParkEscalation({
      db,
      postEpicComment: post,
      now: () => ARMED_AT + 2 * 24 * 60 * 60 * 1000,
      thresholdMs: 24 * 60 * 60 * 1000,
    });
    expect(n).toBe(1);
    expect(posted).toHaveLength(1);
  });

  // Threshold sanitization (#253 review): a misconfigured threshold must self-heal
  // to the default, never silently halt escalation (NaN) nor bulk-escalate (<= 0).
  test("a NaN threshold falls back to the default (does not silently halt escalation)", async () => {
    seedParked("answered-question");
    const { posted, post } = capturePoster();
    // Default would escalate at STALE_NOW (8 days). NaN must not pass through —
    // `now - armedAt > NaN` is always false, which would silently suppress.
    const n = await runParkEscalation({
      db,
      postEpicComment: post,
      now: () => STALE_NOW,
      thresholdMs: Number.NaN,
    });
    expect(n).toBe(1);
    expect(posted).toHaveLength(1);
  });

  test("a NaN threshold does not escalate a park younger than the default", async () => {
    seedParked("answered-question");
    const { posted, post } = capturePoster();
    // The companion test above (NaN at STALE_NOW → 1) proves NaN didn't leak; this
    // one pins the *other* edge — a 1-hour-old park stays fresh under the fallback,
    // confirming NaN became the 7-day default and not 0 (which escalates instantly).
    const n = await runParkEscalation({
      db,
      postEpicComment: post,
      now: () => ARMED_AT + 60 * 60 * 1000,
      thresholdMs: Number.NaN,
    });
    expect(n).toBe(0);
    expect(posted).toHaveLength(0);
  });

  test("a negative threshold falls back to the default (does not bulk-escalate)", async () => {
    seedParked("answered-question");
    const { posted, post } = capturePoster();
    // A fresh, 1-hour-old park: a negative threshold would make `now - armedAt > neg`
    // true → immediate escalation. Falling back to the 7-day default keeps it fresh.
    const n = await runParkEscalation({
      db,
      postEpicComment: post,
      now: () => ARMED_AT + 60 * 60 * 1000,
      thresholdMs: -1000,
    });
    expect(n).toBe(0);
    expect(posted).toHaveLength(0);
  });

  test("a zero threshold falls back to the default (does not bulk-escalate)", async () => {
    seedParked("answered-question");
    const { posted, post } = capturePoster();
    // threshold 0 → every park instantly stale (`now - armedAt > 0`). Must default.
    const n = await runParkEscalation({
      db,
      postEpicComment: post,
      now: () => ARMED_AT + 60 * 60 * 1000,
      thresholdMs: 0,
    });
    expect(n).toBe(0);
    expect(posted).toHaveLength(0);
  });

  test("an infinite threshold falls back to the default (does not silently halt)", async () => {
    seedParked("answered-question");
    const { posted, post } = capturePoster();
    // Infinity would never let a park go stale. Falls back to the default → escalates.
    const n = await runParkEscalation({
      db,
      postEpicComment: post,
      now: () => STALE_NOW,
      thresholdMs: Number.POSITIVE_INFINITY,
    });
    expect(n).toBe(1);
    expect(posted).toHaveLength(1);
  });

  test("a threshold above the 90-day ceiling is clamped so escalation still fires", async () => {
    // A park armed exactly the ceiling ago, with a misconfigured threshold of 2×
    // the ceiling. Un-clamped, 90d < 180d → it would NEVER escalate; clamped below
    // WAITFOR_TIMEOUT_MS, 90d > (ceiling - 1) → it escalates. This is the invariant
    // that escalation always fires before a park is considered ceiling-stale.
    seedParked("answered-question");
    const { posted, post } = capturePoster();
    const n = await runParkEscalation({
      db,
      postEpicComment: post,
      now: () => ARMED_AT + WAITFOR_TIMEOUT_MS,
      thresholdMs: WAITFOR_TIMEOUT_MS * 2,
    });
    expect(n).toBe(1);
    expect(posted).toHaveLength(1);
  });
});

describe("runParkEscalation — resilience & no-seam", () => {
  test("absent postEpicComment records NO event (retries once a poster is wired)", async () => {
    const id = seedParked("answered-question");
    const n = await runParkEscalation({ db, now: () => STALE_NOW });
    expect(n).toBe(0);
    // Critically: no marker burned, so a later pass with a poster still escalates.
    expect(hasEventOfType(db, id, PARK_ESCALATED_EVENT)).toBe(false);
    const { posted, post } = capturePoster();
    await runParkEscalation({ db, postEpicComment: post, now: () => STALE_NOW });
    expect(posted).toHaveLength(1);
  });

  test("a post failure records NO event and is isolated from other parks", async () => {
    const bad = seedParked("answered-question", { epic: 1 });
    const good = seedParked("answered-question", { epic: 2 });
    const posted: Posted[] = [];
    const n = await runParkEscalation({
      db,
      now: () => STALE_NOW,
      postEpicComment: async (repo, epicRef, body) => {
        if (epicRef === "1") throw new Error("gh boom");
        posted.push({ repo, epicRef, body });
      },
    });
    expect(n).toBe(1); // only the good one escalated
    expect(posted.map((p) => p.epicRef)).toEqual(["2"]);
    // The failed one burned no marker → it retries next pass.
    expect(hasEventOfType(db, bad, PARK_ESCALATED_EVENT)).toBe(false);
    expect(hasEventOfType(db, good, PARK_ESCALATED_EVENT)).toBe(true);
  });

  test("maxPerPass caps the escalations in one pass", async () => {
    for (let i = 0; i < 5; i++) seedParked("answered-question", { epic: 100 + i });
    const { posted, post } = capturePoster();
    const n = await runParkEscalation({
      db,
      postEpicComment: post,
      now: () => STALE_NOW,
      maxPerPass: 2,
    });
    expect(n).toBe(2);
    expect(posted).toHaveLength(2);
  });

  // A misconfigured cap must self-heal to the default — never to a value that
  // silently suppresses escalations: `slice(0, NaN)` is `[]`, `slice(0, -1)` drops
  // one. Same sanitization class as thresholdMs, the sibling input one line over.
  test("a NaN maxPerPass falls back to the default (does not halt all escalation)", async () => {
    for (let i = 0; i < 3; i++) seedParked("answered-question", { epic: 200 + i });
    const { posted, post } = capturePoster();
    const n = await runParkEscalation({
      db,
      postEpicComment: post,
      now: () => STALE_NOW,
      maxPerPass: Number.NaN,
    });
    // Default cap is 10 ≥ 3, so all three escalate. A leaked NaN would slice to [].
    expect(n).toBe(3);
    expect(posted).toHaveLength(3);
  });

  test("a non-positive maxPerPass falls back to the default (does not drop parks)", async () => {
    for (let i = 0; i < 3; i++) seedParked("answered-question", { epic: 300 + i });
    const { posted, post } = capturePoster();
    const n = await runParkEscalation({
      db,
      postEpicComment: post,
      now: () => STALE_NOW,
      maxPerPass: 0,
    });
    // 0 would escalate nothing, -1 would drop the last — both wrong. Defaults to 10.
    expect(n).toBe(3);
    expect(posted).toHaveLength(3);
  });
});
