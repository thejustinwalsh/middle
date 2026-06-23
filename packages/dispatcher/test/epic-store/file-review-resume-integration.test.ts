/**
 * Integration: a file-mode Epic parked on `review-changes` resumes when its PR
 * gets a CHANGES_REQUESTED review — the real poller path (#200 gap 1).
 *
 * Drives the genuine wiring end to end: `runPoller` → the routing poll gateway
 * (file mode for this repo) → `makeFilePollGateway.findPrForEpic` resolving the
 * slug's PR from the on-disk Epic file's `meta.pr` stamp → `gh.prSnapshot` by
 * number → `classifyReviewOutcome` → `fireSignal`. Before this gap closed, the
 * file gateway returned `null` for a slug and the parked workflow never resumed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAndMigrate } from "../../src/db.ts";
import { makeRoutingPollGateway } from "../../src/epic-store/index.ts";
import { renderEpicFile } from "../../src/epic-store/epic-file/renderer.ts";
import type { EpicFile } from "../../src/epic-store/epic-file/types.ts";
import {
  runPoller,
  type EpicPrLifecycle,
  type PollGateway,
  type PrSnapshot,
  type RateLimitStatus,
  type ResumeSignalPayload,
} from "../../src/poller.ts";
import {
  armWaitForSignal,
  createWorkflowRecord,
  updateWorkflow,
} from "../../src/workflow-record.ts";
import { signalNameFor } from "../../src/workflows/implementation.ts";
import { setEpicStoreConfig } from "../../src/repo-config.ts";

const REPO = "o/file-repo";
const SLUG = "rollout-epic-store";
const PR = 77;
const ARMED_AT = 1_000_000;

let scratch: string;
let db: Database;
let repoRoot: string;
let epicsDir: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "middle-review-resume-"));
  db = openAndMigrate(join(scratch, "db.sqlite3"));
  repoRoot = join(scratch, "repo");
  epicsDir = join(repoRoot, "planning/epics");
  mkdirSync(epicsDir, { recursive: true });
  setEpicStoreConfig(db, REPO, {
    mode: "file",
    epicsDir: "planning/epics",
    stateFile: ".middle/state.md",
  });
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** Write a real Epic file under `epicsDir`, optionally stamping `meta.pr`. */
function seedEpic(pr?: number): void {
  const epic: EpicFile = {
    title: "feat: rollout the epic store",
    meta: pr === undefined ? { slug: SLUG } : { slug: SLUG, pr },
    context: "ctx",
    acceptanceCriteria: [],
    subIssues: [],
    conversation: [],
  };
  writeFileSync(join(epicsDir, `${SLUG}.md`), renderEpicFile(epic));
}

/** Park an `implementation` workflow on the slug with an armed review-changes wait. */
function seedParkedOnReview(): string {
  const id = crypto.randomUUID();
  createWorkflowRecord(db, {
    id,
    kind: "implementation",
    repo: REPO,
    epicRef: SLUG,
    adapter: "claude",
  });
  updateWorkflow(db, id, { state: "waiting-human" });
  armWaitForSignal(
    db,
    signalNameFor(SLUG, "review-changes"),
    id,
    JSON.stringify({ reason: "review-changes" }),
  );
  db.run("UPDATE waitfor_signals SET created_at = ? WHERE workflow_id = ?", [ARMED_AT, id]);
  return id;
}

/** A gh poll backend that returns a fresh CHANGES_REQUESTED snapshot for `PR`. */
function ghBackend(): { gh: PollGateway; prSnapshotCalls: number[] } {
  const prSnapshotCalls: number[] = [];
  const gh: PollGateway = {
    async listIssueComments(): Promise<never[]> {
      return [];
    },
    async findPrForEpic(): Promise<PrSnapshot | null> {
      return null; // a slug never reaches this — meta.pr → prSnapshot is the path
    },
    async findEpicPrLifecycle(): Promise<EpicPrLifecycle | null> {
      return null;
    },
    async prSnapshot(_repo, prNumber): Promise<PrSnapshot | null> {
      prSnapshotCalls.push(prNumber);
      return {
        number: prNumber,
        reviewDecision: "CHANGES_REQUESTED",
        reviews: [
          {
            id: 7,
            state: "CHANGES_REQUESTED",
            authorLogin: "coderabbitai[bot]",
            submittedAt: ARMED_AT + 10, // fresh: posted after the wait armed
            body: "Actionable comments posted: 3",
          },
        ],
        labels: [],
      };
    },
    async prLifecycle(_repo, prNumber): Promise<EpicPrLifecycle | null> {
      return { number: prNumber, state: "OPEN" };
    },
    async getRateLimit(): Promise<RateLimitStatus> {
      return { remaining: 5000, resetAt: 0 };
    },
  };
  return { gh, prSnapshotCalls };
}

function captureFires(): {
  fired: Array<{ workflowId: string; payload: ResumeSignalPayload }>;
  fireSignal: (id: string, p: ResumeSignalPayload) => Promise<void>;
} {
  const fired: Array<{ workflowId: string; payload: ResumeSignalPayload }> = [];
  return {
    fired,
    fireSignal: async (workflowId, payload) => void fired.push({ workflowId, payload }),
  };
}

describe("file-mode PR-review resume (real poller path)", () => {
  test("a CHANGES_REQUESTED review on the stamped PR resumes the parked file-mode Epic", async () => {
    seedEpic(PR);
    const id = seedParkedOnReview();
    const { gh, prSnapshotCalls } = ghBackend();
    const github = makeRoutingPollGateway({ db, resolveRepoPath: () => repoRoot, ghPoll: gh });
    const { fired, fireSignal } = captureFires();

    const n = await runPoller({ db, github, fireSignal, now: () => ARMED_AT + 1000 });

    expect(n).toBe(1);
    expect(prSnapshotCalls).toEqual([PR]); // resolved via meta.pr, fetched by number
    expect(fired).toEqual([
      {
        workflowId: id,
        payload: {
          reason: "review-changes",
          outcome: "changes-requested",
          reviewId: 7,
          decision: "CHANGES_REQUESTED",
        },
      },
    ]);
  });

  test("no resume while the Epic file has no stamped meta.pr (PR not opened yet)", async () => {
    seedEpic(); // no meta.pr
    seedParkedOnReview();
    const { gh, prSnapshotCalls } = ghBackend();
    const github = makeRoutingPollGateway({ db, resolveRepoPath: () => repoRoot, ghPoll: gh });
    const { fired, fireSignal } = captureFires();

    const n = await runPoller({ db, github, fireSignal, now: () => ARMED_AT + 1000 });

    expect(n).toBe(0);
    expect(prSnapshotCalls).toEqual([]); // nothing to fetch
    expect(fired).toEqual([]);
  });

  test("an APPROVED review on the stamped PR resumes the parked file-mode Epic as resolved", async () => {
    seedEpic(PR);
    const id = seedParkedOnReview();

    // Backend returns APPROVED review + APPROVED decision.
    const prSnapshotCalls: number[] = [];
    const gh: PollGateway = {
      async listIssueComments(): Promise<never[]> {
        return [];
      },
      async findPrForEpic(): Promise<PrSnapshot | null> {
        return null;
      },
      async findEpicPrLifecycle(): Promise<EpicPrLifecycle | null> {
        return null;
      },
      async prSnapshot(_repo, prNumber): Promise<PrSnapshot | null> {
        prSnapshotCalls.push(prNumber);
        return {
          number: prNumber,
          reviewDecision: "APPROVED",
          reviews: [
            {
              id: 9,
              state: "APPROVED",
              authorLogin: "reviewer",
              submittedAt: ARMED_AT + 20, // fresh: after the wait armed
              body: "LGTM",
            },
          ],
          labels: [],
        };
      },
      async prLifecycle(_repo, prNumber): Promise<EpicPrLifecycle | null> {
        return { number: prNumber, state: "OPEN" };
      },
      async getRateLimit(): Promise<RateLimitStatus> {
        return { remaining: 5000, resetAt: 0 };
      },
    };
    const github = makeRoutingPollGateway({ db, resolveRepoPath: () => repoRoot, ghPoll: gh });
    const { fired, fireSignal } = captureFires();

    const n = await runPoller({ db, github, fireSignal, now: () => ARMED_AT + 1000 });

    expect(n).toBe(1);
    expect(prSnapshotCalls).toEqual([PR]);
    expect(fired).toEqual([
      {
        workflowId: id,
        payload: {
          reason: "review-changes",
          outcome: "resolved",
          reviewId: 9,
          decision: "APPROVED",
        },
      },
    ]);
  });

  test("meta.pr stamp added after parking is picked up on the next tick", async () => {
    // Seed Epic WITHOUT a meta.pr stamp — PR hasn't been opened yet.
    seedEpic(); // no meta.pr
    const id = seedParkedOnReview();
    const { gh, prSnapshotCalls } = ghBackend();
    const github = makeRoutingPollGateway({ db, resolveRepoPath: () => repoRoot, ghPoll: gh });
    const { fired, fireSignal } = captureFires();

    // Tick 1: no meta.pr stamp → no PR fetch, no fire.
    const n1 = await runPoller({ db, github, fireSignal, now: () => ARMED_AT + 1000 });
    expect(n1).toBe(0);
    expect(prSnapshotCalls).toEqual([]);
    expect(fired).toEqual([]);

    // The agent opens a PR and stamps meta.pr into the Epic file.
    seedEpic(PR);

    // Tick 2: same gateway re-reads the Epic file fresh (no caching of the PR
    // number). The wait is still armed (not fired), so the poller resumes it.
    const n2 = await runPoller({ db, github, fireSignal, now: () => ARMED_AT + 2000 });
    expect(n2).toBe(1);
    expect(prSnapshotCalls).toEqual([PR]);
    expect(fired).toEqual([
      {
        workflowId: id,
        payload: {
          reason: "review-changes",
          outcome: "changes-requested",
          reviewId: 7,
          decision: "CHANGES_REQUESTED",
        },
      },
    ]);
  });
});
