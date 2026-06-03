import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFilePollGateway } from "../../src/epic-store/file-poll-gateway.ts";
import { renderEpicFile } from "../../src/epic-store/epic-file/renderer.ts";
import type { EpicFile } from "../../src/epic-store/epic-file/types.ts";
import type {
  EpicPrLifecycle,
  PollGateway,
  PrSnapshot,
  RateLimitStatus,
} from "../../src/poller.ts";

function tmpEpicsDir(): string {
  return mkdtempSync(join(tmpdir(), "middle-poll-"));
}

function seedEpic(dir: string, epic: EpicFile): void {
  writeFileSync(join(dir, `${epic.meta.slug}.md`), renderEpicFile(epic));
}

function baseEpic(conversation: EpicFile["conversation"]): EpicFile {
  return {
    title: "feat: x",
    meta: { slug: "rollout-epic-store" },
    context: "ctx",
    acceptanceCriteria: [],
    subIssues: [],
    conversation,
  };
}

/** A poll gh backend stub recording delegated calls. */
function ghStub(): {
  gh: PollGateway;
  calls: { findPrForEpic: string[]; findEpicPrLifecycle: string[]; rateLimit: number };
} {
  const calls = {
    findPrForEpic: [] as string[],
    findEpicPrLifecycle: [] as string[],
    rateLimit: 0,
  };
  const gh: PollGateway = {
    async listIssueComments() {
      return [{ id: 1, authorLogin: "octocat", authorIsBot: false, createdAt: 0, body: "gh" }];
    },
    async findPrForEpic(_repo, epicRef): Promise<PrSnapshot | null> {
      calls.findPrForEpic.push(epicRef);
      return { number: 5, reviewDecision: null, reviews: [], labels: [] };
    },
    async findEpicPrLifecycle(_repo, epicRef): Promise<EpicPrLifecycle | null> {
      calls.findEpicPrLifecycle.push(epicRef);
      return { number: 5, state: "OPEN" };
    },
    async getRateLimit(): Promise<RateLimitStatus> {
      calls.rateLimit += 1;
      return { remaining: 4999, resetAt: 0 };
    },
  };
  return { gh, calls };
}

describe("filePollGateway", () => {
  test("listIssueComments derives authorIsBot structurally from the marker kind", async () => {
    const dir = tmpEpicsDir();
    seedEpic(
      dir,
      baseEpic([
        { kind: "dispatch-event", ts: "2026-06-03T00:00:00.000Z", eventKind: "comment", body: "e" },
        {
          kind: "question",
          id: 1,
          status: "resolved",
          ts: "2026-06-03T01:00:00.000Z",
          body: "q",
          answer: { body: "a" },
        },
      ]),
    );
    const comments = await makeFilePollGateway({
      epicsDir: dir,
      gh: ghStub().gh,
    }).listIssueComments("o/r", "rollout-epic-store");
    expect(comments.map((c) => ({ body: c.body, authorIsBot: c.authorIsBot }))).toEqual([
      { body: "e", authorIsBot: true }, // dispatch-event → bot
      { body: "q", authorIsBot: true }, // question → bot
      { body: "a", authorIsBot: false }, // answer → human (the resume signal)
    ]);
    expect(comments[1]!.createdAt).toBe(Date.parse("2026-06-03T01:00:00.000Z"));
  });

  test("listIssueComments delegates to gh for a non-Epic (PR-number) ref", async () => {
    const comments = await makeFilePollGateway({
      epicsDir: tmpEpicsDir(),
      gh: ghStub().gh,
    }).listIssueComments("o/r", "42");
    expect(comments[0]!.body).toBe("gh");
  });

  test("findPrForEpic delegates a numeric ref but returns null for a file-mode slug", async () => {
    const { gh, calls } = ghStub();
    const gw = makeFilePollGateway({ epicsDir: tmpEpicsDir(), gh });
    expect(await gw.findPrForEpic("o/r", "rollout-epic-store")).toBeNull();
    expect(calls.findPrForEpic).toEqual([]); // slug never reaches gh's `Closes #N` search
    expect(await gw.findPrForEpic("o/r", "42")).toMatchObject({ number: 5 });
    expect(calls.findPrForEpic).toEqual(["42"]);
  });

  test("findEpicPrLifecycle delegates a numeric ref but returns null for a slug", async () => {
    const { gh, calls } = ghStub();
    const gw = makeFilePollGateway({ epicsDir: tmpEpicsDir(), gh });
    expect(await gw.findEpicPrLifecycle("o/r", "rollout-epic-store")).toBeNull();
    expect(await gw.findEpicPrLifecycle("o/r", "42")).toMatchObject({ number: 5, state: "OPEN" });
    expect(calls.findEpicPrLifecycle).toEqual(["42"]);
  });

  test("getRateLimit delegates straight to gh", async () => {
    const { gh, calls } = ghStub();
    const budget = await makeFilePollGateway({ epicsDir: tmpEpicsDir(), gh }).getRateLimit();
    expect(budget.remaining).toBe(4999);
    expect(calls.rateLimit).toBe(1);
  });
});
