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
  calls: {
    findPrForEpic: string[];
    findEpicPrLifecycle: string[];
    prSnapshot: number[];
    prLifecycle: number[];
    rateLimit: number;
  };
} {
  const calls = {
    findPrForEpic: [] as string[],
    findEpicPrLifecycle: [] as string[],
    prSnapshot: [] as number[],
    prLifecycle: [] as number[],
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
    async prSnapshot(_repo, prNumber): Promise<PrSnapshot | null> {
      calls.prSnapshot.push(prNumber);
      return { number: prNumber, reviewDecision: "CHANGES_REQUESTED", reviews: [], labels: [] };
    },
    async prLifecycle(_repo, prNumber): Promise<EpicPrLifecycle | null> {
      calls.prLifecycle.push(prNumber);
      return { number: prNumber, state: "MERGED" };
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

  test("findPrForEpic resolves a slug via meta.pr; delegates a numeric ref to gh's finder", async () => {
    const { gh, calls } = ghStub();
    const dir = tmpEpicsDir();
    seedEpic(dir, { ...baseEpic([]), meta: { slug: "rollout-epic-store", pr: 77 } });
    const gw = makeFilePollGateway({ epicsDir: dir, gh });
    // Slug → resolve `meta.pr` (77) → gh.prSnapshot by number (never the `Closes #N` finder).
    expect(await gw.findPrForEpic("o/r", "rollout-epic-store")).toMatchObject({
      number: 77,
      reviewDecision: "CHANGES_REQUESTED",
    });
    expect(calls.prSnapshot).toEqual([77]);
    expect(calls.findPrForEpic).toEqual([]);
    // Numeric ref → gh's `Closes #N` finder.
    expect(await gw.findPrForEpic("o/r", "42")).toMatchObject({ number: 5 });
    expect(calls.findPrForEpic).toEqual(["42"]);
  });

  test("findPrForEpic returns null for a slug whose Epic file has no stamped meta.pr", async () => {
    const { gh, calls } = ghStub();
    const dir = tmpEpicsDir();
    seedEpic(dir, baseEpic([])); // no meta.pr
    const gw = makeFilePollGateway({ epicsDir: dir, gh });
    expect(await gw.findPrForEpic("o/r", "rollout-epic-store")).toBeNull();
    expect(calls.prSnapshot).toEqual([]); // no PR to fetch
    expect(calls.findPrForEpic).toEqual([]); // and never the slug-rejecting finder
  });

  test("findEpicPrLifecycle resolves a slug via meta.pr; delegates a numeric ref to gh", async () => {
    const { gh, calls } = ghStub();
    const dir = tmpEpicsDir();
    seedEpic(dir, { ...baseEpic([]), meta: { slug: "rollout-epic-store", pr: 77 } });
    const gw = makeFilePollGateway({ epicsDir: dir, gh });
    expect(await gw.findEpicPrLifecycle("o/r", "rollout-epic-store")).toMatchObject({
      number: 77,
      state: "MERGED",
    });
    expect(calls.prLifecycle).toEqual([77]);
    expect(await gw.findEpicPrLifecycle("o/r", "42")).toMatchObject({ number: 5, state: "OPEN" });
    expect(calls.findEpicPrLifecycle).toEqual(["42"]);
  });

  test("findEpicPrLifecycle returns null for a slug with no stamped meta.pr", async () => {
    const { gh, calls } = ghStub();
    const dir = tmpEpicsDir();
    seedEpic(dir, baseEpic([]));
    const gw = makeFilePollGateway({ epicsDir: dir, gh });
    expect(await gw.findEpicPrLifecycle("o/r", "rollout-epic-store")).toBeNull();
    expect(calls.prLifecycle).toEqual([]);
  });

  test("a numeric-named file Epic (e.g. 42.md) resolves via meta.pr, not gh's #42 finder (#200)", async () => {
    // The discriminator is the Epic file on disk, not a `^\d+$` shape — so a file
    // Epic whose slug happens to be numeric still resolves its PR from meta.pr
    // instead of being mistaken for github issue #42.
    const { gh, calls } = ghStub();
    const dir = tmpEpicsDir();
    seedEpic(dir, { ...baseEpic([]), meta: { slug: "42", pr: 88 } });
    const gw = makeFilePollGateway({ epicsDir: dir, gh });
    expect(await gw.findPrForEpic("o/r", "42")).toMatchObject({ number: 88 });
    expect(calls.prSnapshot).toEqual([88]);
    expect(calls.findPrForEpic).toEqual([]); // never the github `Closes #42` finder
  });

  test("prSnapshot / prLifecycle delegate straight to gh by PR number", async () => {
    const { gh, calls } = ghStub();
    const gw = makeFilePollGateway({ epicsDir: tmpEpicsDir(), gh });
    expect(await gw.prSnapshot("o/r", 9)).toMatchObject({ number: 9 });
    expect(await gw.prLifecycle("o/r", 9)).toMatchObject({ number: 9, state: "MERGED" });
    expect(calls.prSnapshot).toEqual([9]);
    expect(calls.prLifecycle).toEqual([9]);
  });

  test("getRateLimit delegates straight to gh", async () => {
    const { gh, calls } = ghStub();
    const budget = await makeFilePollGateway({ epicsDir: tmpEpicsDir(), gh }).getRateLimit();
    expect(budget.remaining).toBe(4999);
    expect(calls.rateLimit).toBe(1);
  });
});
