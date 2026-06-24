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
import { signalNameFor, type ResumeReason } from "../src/workflows/implementation.ts";

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
});
