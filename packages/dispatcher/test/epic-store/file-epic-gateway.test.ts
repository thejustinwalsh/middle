import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EpicGateway, PullRequest } from "../../src/github.ts";
import {
  FILE_AGENT_LOGIN,
  FILE_HUMAN_LOGIN,
  makeFileEpicGateway,
} from "../../src/epic-store/file-epic-gateway.ts";
import { readEpicFile } from "../../src/epic-store/epic-file-io.ts";
import { renderEpicFile } from "../../src/epic-store/epic-file/renderer.ts";
import type { EpicFile } from "../../src/epic-store/epic-file/types.ts";
import { appendQuestion } from "../../src/epic-store/index.ts";

function tmpEpicsDir(): string {
  return mkdtempSync(join(tmpdir(), "middle-epics-"));
}

/** A minimal valid Epic file model, overridable per test. */
function epicFixture(over: Partial<EpicFile> = {}): EpicFile {
  return {
    title: "feat: rollout the epic store",
    meta: { slug: "rollout-epic-store", labels: ["epic", "agent:claude"], ...over.meta },
    context: "Roll out the file-backed Epic store.",
    acceptanceCriteria: [{ checked: false, text: "ship it" }],
    subIssues: [
      { id: 1, checked: true, title: "1 — foundation", body: "" },
      { id: 2, checked: false, title: "2 — gateways", body: "" },
    ],
    conversation: [],
    ...over,
  };
}

/** Write an Epic fixture to `<dir>/<slug>.md` via the renderer (guaranteed parseable). */
function seedEpic(dir: string, epic: EpicFile): void {
  writeFileSync(join(dir, `${epic.meta.slug}.md`), renderEpicFile(epic));
}

/** A gh backend stub that records the delegated calls and returns canned PRs. */
function ghStub(over: Partial<EpicGateway> = {}): {
  gh: EpicGateway;
  calls: { postComment: Array<{ ref: string; body: string }>; getPullRequest: number[] };
} {
  const calls = {
    postComment: [] as Array<{ ref: string; body: string }>,
    getPullRequest: [] as number[],
  };
  const gh = {
    async postComment(_repo: string, ref: string, body: string) {
      calls.postComment.push({ ref, body });
    },
    async getPullRequest(_repo: string, prNumber: number): Promise<PullRequest | null> {
      calls.getPullRequest.push(prNumber);
      return { number: prNumber, body: "PR body", isDraft: true };
    },
    async getCommentAuthor() {
      return { login: "octocat", isBot: false };
    },
    async getIssueLabels() {
      return ["from-gh"];
    },
    async listIssueComments() {
      return [
        { authorLogin: "octocat", body: "gh comment", url: "https://github.com/o/r/issues/42" },
      ];
    },
    ...over,
  } as unknown as EpicGateway;
  return { gh, calls };
}

describe("fileEpicGateway", () => {
  test("listOpenEpics scans the dir, derives sub-issue progress, skips closed", async () => {
    const dir = tmpEpicsDir();
    seedEpic(dir, epicFixture());
    seedEpic(
      dir,
      epicFixture({ meta: { slug: "done-epic", closed: true }, title: "old", subIssues: [] }),
    );
    const { gh } = ghStub();
    const epics = await makeFileEpicGateway({ epicsDir: dir, gh }).listOpenEpics("o/r");
    expect(epics).toHaveLength(1);
    expect(epics[0]).toMatchObject({
      ref: "rollout-epic-store",
      number: null,
      title: "feat: rollout the epic store",
      state: "open",
      labels: ["epic", "agent:claude"],
      subTotal: 2,
      subClosed: 1,
    });
  });

  test("listIssueComments maps the conversation; answer is attributed to the human", async () => {
    const dir = tmpEpicsDir();
    seedEpic(
      dir,
      epicFixture({
        conversation: [
          {
            kind: "dispatch-event",
            ts: "2026-06-03T00:00:00.000Z",
            eventKind: "comment",
            body: "dispatched",
          },
          {
            kind: "question",
            id: 1,
            status: "resolved",
            ts: "2026-06-03T01:00:00.000Z",
            body: "which approach?",
            answer: { body: "approach A" },
          },
        ],
      }),
    );
    const { gh } = ghStub();
    const comments = await makeFileEpicGateway({ epicsDir: dir, gh }).listIssueComments(
      "o/r",
      "rollout-epic-store",
    );
    expect(comments.map((c) => ({ authorLogin: c.authorLogin, body: c.body }))).toEqual([
      { authorLogin: FILE_AGENT_LOGIN, body: "dispatched" },
      { authorLogin: FILE_AGENT_LOGIN, body: "which approach?" },
      { authorLogin: FILE_HUMAN_LOGIN, body: "approach A" },
    ]);
    expect(comments[2]!.url).toMatch(/#answer-1$/);
  });

  test("listIssueComments delegates to gh for a non-Epic (PR-number) ref", async () => {
    const dir = tmpEpicsDir();
    const { gh } = ghStub();
    const comments = await makeFileEpicGateway({ epicsDir: dir, gh }).listIssueComments(
      "o/r",
      "42",
    );
    expect(comments[0]!.body).toBe("gh comment");
  });

  test("getCommentAuthor discriminates human (answer) from agent by the file:// fragment", async () => {
    const dir = tmpEpicsDir();
    const gw = makeFileEpicGateway({ epicsDir: dir, gh: ghStub().gh });
    expect(await gw.getCommentAuthor("o/r", "file:///e/rollout.md#answer-1")).toEqual({
      login: FILE_HUMAN_LOGIN,
      isBot: false,
    });
    expect(await gw.getCommentAuthor("o/r", "file:///e/rollout.md#question-1")).toEqual({
      login: FILE_AGENT_LOGIN,
      isBot: true,
    });
  });

  test("getCommentAuthor delegates a github.com URL to gh", async () => {
    const gw = makeFileEpicGateway({ epicsDir: tmpEpicsDir(), gh: ghStub().gh });
    expect(
      await gw.getCommentAuthor("o/r", "https://github.com/o/r/issues/1#issuecomment-9"),
    ).toEqual({
      login: "octocat",
      isBot: false,
    });
  });

  test("getIssueLabels reads the Epic meta labels", async () => {
    const dir = tmpEpicsDir();
    seedEpic(dir, epicFixture());
    const labels = await makeFileEpicGateway({ epicsDir: dir, gh: ghStub().gh }).getIssueLabels(
      "o/r",
      "rollout-epic-store",
    );
    expect(labels).toEqual(["epic", "agent:claude"]);
  });

  test("postComment appends a re-parseable dispatch-event block", async () => {
    const dir = tmpEpicsDir();
    seedEpic(dir, epicFixture());
    await makeFileEpicGateway({
      epicsDir: dir,
      gh: ghStub().gh,
      now: () => new Date("2026-06-03T02:00:00.000Z"),
    }).postComment("o/r", "rollout-epic-store", "recorded a dispatch");
    const reparsed = readEpicFile(dir, "rollout-epic-store");
    expect(reparsed!.conversation).toEqual([
      {
        kind: "dispatch-event",
        ts: "2026-06-03T02:00:00.000Z",
        eventKind: "comment",
        body: "recorded a dispatch",
      },
    ]);
  });

  test("postComment delegates a PR-number ref to gh (no Epic file for it)", async () => {
    const { gh, calls } = ghStub();
    await makeFileEpicGateway({ epicsDir: tmpEpicsDir(), gh }).postComment(
      "o/r",
      "42",
      "PR comment",
    );
    expect(calls.postComment).toEqual([{ ref: "42", body: "PR comment" }]);
  });

  test("findEpicPr returns null without a stamped pr, and delegates to gh when present", async () => {
    const dir = tmpEpicsDir();
    seedEpic(dir, epicFixture());
    const { gh, calls } = ghStub();
    const gw = makeFileEpicGateway({ epicsDir: dir, gh });
    expect(await gw.findEpicPr("o/r", "rollout-epic-store")).toBeNull();

    seedEpic(dir, epicFixture({ meta: { slug: "rollout-epic-store", pr: 88 } }));
    const pr = await gw.findEpicPr("o/r", "rollout-epic-store");
    expect(pr).toMatchObject({ number: 88, isDraft: true });
    expect(calls.getPullRequest).toEqual([88]);
  });

  test("findEpicPr returns null when the Epic file is absent", async () => {
    const gw = makeFileEpicGateway({ epicsDir: tmpEpicsDir(), gh: ghStub().gh });
    expect(await gw.findEpicPr("o/r", "no-such-epic")).toBeNull();
  });

  test("addLabel appends to meta labels and is a no-op if already present", async () => {
    const dir = tmpEpicsDir();
    seedEpic(dir, epicFixture());
    const gw = makeFileEpicGateway({ epicsDir: dir, gh: ghStub().gh });
    await gw.addLabel("o/r", "rollout-epic-store", "approved");
    expect(readEpicFile(dir, "rollout-epic-store")!.meta.labels).toEqual([
      "epic",
      "agent:claude",
      "approved",
    ]);
    await gw.addLabel("o/r", "rollout-epic-store", "approved"); // no-op
    expect(readEpicFile(dir, "rollout-epic-store")!.meta.labels).toEqual([
      "epic",
      "agent:claude",
      "approved",
    ]);
  });

  test("a present-but-malformed Epic file surfaces the parser's named error", async () => {
    const dir = tmpEpicsDir();
    writeFileSync(join(dir, "broken.md"), "not an epic file\n");
    const gw = makeFileEpicGateway({ epicsDir: dir, gh: ghStub().gh });
    await expect(gw.getIssueLabels("o/r", "broken")).rejects.toThrow(/document marker/);
  });

  test("postComment writes atomically — no `.tmp` sibling left behind", async () => {
    const dir = tmpEpicsDir();
    seedEpic(dir, epicFixture());
    await makeFileEpicGateway({ epicsDir: dir, gh: ghStub().gh }).postComment(
      "o/r",
      "rollout-epic-store",
      "x",
    );
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

describe("appendQuestion — idempotent on a repeated park (#205)", () => {
  const SLUG = "rollout-epic-store";
  const questions = (dir: string) =>
    readEpicFile(dir, SLUG)!.conversation.filter((e) => e.kind === "question");

  test("re-asking the identical open question is a no-op", () => {
    const dir = tmpEpicsDir();
    seedEpic(dir, epicFixture());
    const opts = { question: "Which API base URL?", kind: "question" as const };

    appendQuestion(dir, SLUG, opts);
    appendQuestion(dir, SLUG, opts);
    appendQuestion(dir, SLUG, opts);
    expect(questions(dir)).toHaveLength(1);
  });

  test("a different question (or different kind/context) appends a new entry", () => {
    const dir = tmpEpicsDir();
    seedEpic(dir, epicFixture());

    appendQuestion(dir, SLUG, { question: "Q1", kind: "question" });
    appendQuestion(dir, SLUG, { question: "Q2", kind: "question" }); // different text
    appendQuestion(dir, SLUG, { question: "Q2", kind: "complexity" }); // different kind
    appendQuestion(dir, SLUG, { question: "Q2", context: "extra", kind: "complexity" }); // different body
    expect(questions(dir)).toHaveLength(4);
  });

  test("round-trip purity survives the skip (renderer remains the sole marker writer)", () => {
    const dir = tmpEpicsDir();
    seedEpic(dir, epicFixture());
    appendQuestion(dir, SLUG, { question: "Q", kind: "question" });
    const after = readFileSync(join(dir, `${SLUG}.md`), "utf8");
    appendQuestion(dir, SLUG, { question: "Q", kind: "question" }); // skipped
    expect(readFileSync(join(dir, `${SLUG}.md`), "utf8")).toBe(after);
  });
});
