/**
 * Integration: the three file gateways composed over one real on-disk Epic file,
 * exercising the Phase-1 file-mode lifecycle through the real parser/renderer and
 * filesystem (no mocks of the file layer):
 *
 *   author Epic → dispatcher records a dispatch-event (fileEpicGateway.postComment)
 *   → agent asks a question → human edits the answer block on disk
 *   → filePollGateway.listIssueComments surfaces the answer as a human reply.
 *
 * This is the gateway-level integration; the daemon-HTTP-boot file-mode dispatch
 * (selector wiring) lands with #193's bootstrap selector and #196's parity test.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFileEpicGateway } from "../../src/epic-store/file-epic-gateway.ts";
import { makeFilePollGateway } from "../../src/epic-store/file-poll-gateway.ts";
import { makeFileStateGateway } from "../../src/epic-store/file-state-gateway.ts";
import { epicFilePath, readEpicFile } from "../../src/epic-store/epic-file-io.ts";
import { renderEpicFile } from "../../src/epic-store/epic-file/renderer.ts";
import { classifyNewHumanReply } from "../../src/poller.ts";
import type { EpicGateway } from "../../src/github.ts";
import type { PollGateway } from "../../src/poller.ts";

const SLUG = "rollout-epic-store";

function ghEpicStub(): EpicGateway {
  return {} as unknown as EpicGateway;
}
function ghPollStub(): PollGateway {
  return {} as unknown as PollGateway;
}

describe("file gateways — Phase-1 lifecycle integration", () => {
  test("dispatch-event record, human answer on disk, poll surfaces the human reply", async () => {
    const epicsDir = mkdtempSync(join(tmpdir(), "middle-epics-int-"));
    // Author the Epic file the way `mm init` / a human would (via the renderer).
    writeFileSync(
      epicFilePath(epicsDir, SLUG),
      renderEpicFile({
        title: "feat: file-backed epic store",
        meta: { slug: SLUG, adapter: "claude", labels: ["epic"] },
        context: "Roll out the store.",
        acceptanceCriteria: [{ checked: false, text: "ship" }],
        subIssues: [{ id: 1, checked: false, title: "1 — gateways", body: "" }],
        conversation: [],
      }),
    );

    const epicGw = makeFileEpicGateway({
      epicsDir,
      gh: ghEpicStub(),
      now: () => new Date("2026-06-03T00:00:00.000Z"),
    });
    const pollGw = makeFilePollGateway({ epicsDir, gh: ghPollStub() });

    // 1. Dispatcher records a dispatch-event on the Epic (the github-mode
    //    "comment on the Epic" equivalent), appended to the conversation on disk.
    await epicGw.postComment("o/r", SLUG, "Dispatched wf_abc with the claude adapter.");
    expect(readEpicFile(epicsDir, SLUG)!.conversation).toEqual([
      {
        kind: "dispatch-event",
        ts: "2026-06-03T00:00:00.000Z",
        eventKind: "comment",
        body: "Dispatched wf_abc with the claude adapter.",
      },
    ]);

    // 2. Agent parks asking a question — append a question block (open, no answer).
    const parked = readEpicFile(epicsDir, SLUG)!;
    writeFileSync(
      epicFilePath(epicsDir, SLUG),
      renderEpicFile({
        ...parked,
        conversation: [
          ...parked.conversation,
          {
            kind: "question",
            id: 1,
            status: "open",
            ts: "2026-06-03T01:00:00.000Z",
            body: "Approach A or B?",
          },
        ],
      }),
    );

    // Before the human answers, the poll sees only bot entries → no human reply.
    const parkMs = Date.parse("2026-06-03T00:30:00.000Z");
    const beforeAnswer = await pollGw.listIssueComments("o/r", SLUG);
    expect(classifyNewHumanReply(beforeAnswer, parkMs)).toBeNull();

    // 3. Human edits the answer block on disk (what the file-watcher detects in
    //    Phase 2). Re-render with the answer populated.
    const questioned = readEpicFile(epicsDir, SLUG)!;
    writeFileSync(
      epicFilePath(epicsDir, SLUG),
      renderEpicFile({
        ...questioned,
        conversation: questioned.conversation.map((e) =>
          e.kind === "question" && e.id === 1
            ? { ...e, status: "resolved", answer: { body: "Go with A." } }
            : e,
        ),
      }),
    );

    // 4. The poll now surfaces the answer as a human (non-bot) reply.
    const afterAnswer = await pollGw.listIssueComments("o/r", SLUG);
    const reply = classifyNewHumanReply(afterAnswer, parkMs);
    expect(reply?.body).toBe("Go with A.");
    expect(reply?.authorIsBot).toBe(false);

    // And the Epic gateway attributes that comment's URL to the human.
    const epicComments = await epicGw.listIssueComments("o/r", SLUG);
    const answerComment = epicComments.find((c) => c.body === "Go with A.");
    const author = await epicGw.getCommentAuthor("o/r", answerComment!.url);
    expect(author).toEqual({ login: "human", isBot: false });
  });

  test("state gateway round-trips the recommender state file atomically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "middle-state-int-"));
    const stateFile = join(dir, ".middle", "state.md");
    const stateGw = makeFileStateGateway({ stateFile });
    const body = "<!-- AGENT-QUEUE-STATE v1 -->\n# state\n\nbody\n";
    await stateGw.writeBody("o/r", 0, body);
    expect(await stateGw.readBody("o/r", 0)).toBe(body);
    expect(readFileSync(stateFile, "utf8")).toBe(body);
  });
});
