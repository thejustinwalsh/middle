import { describe, expect, test } from "bun:test";
import type { IssueComment } from "../../src/gates/plan-comment.ts";
import type { GateRunReport } from "../../src/gates/gate-runner.ts";
import {
  type EvidenceGateway,
  evidenceMarker,
  renderEvidence,
  upsertEvidenceComment,
} from "../../src/gates/gate-evidence.ts";

const MIXED: GateRunReport = {
  ok: false,
  failedGate: "test",
  results: [
    {
      name: "typecheck",
      command: "bun run typecheck",
      exitCode: 0,
      stdout: "all good\n",
      stderr: "",
      timedOut: false,
      passed: true,
      durationMs: 1200,
    },
    {
      name: "test",
      command: "bun test",
      exitCode: 1,
      stdout: "1 failing\n",
      stderr: "AssertionError\n",
      timedOut: false,
      passed: false,
      durationMs: 340,
    },
    {
      name: "acceptance",
      command: "bun run accept",
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: true,
      passed: false,
      durationMs: 30000,
    },
  ],
};

describe("renderEvidence", () => {
  const md = renderEvidence(40, MIXED);

  test("carries the per-phase marker so re-runs can find it", () => {
    expect(md).toContain(evidenceMarker(40));
    expect(evidenceMarker(40)).not.toBe(evidenceMarker(41));
  });

  test("summarizes each gate's pass/fail in a table", () => {
    expect(md).toContain("| typecheck |");
    expect(md).toContain("| test |");
    expect(md).toContain("| acceptance |");
    expect(md).toMatch(/pass/i);
    expect(md).toMatch(/fail/i);
    expect(md).toMatch(/timed out/i);
  });

  test("puts full gate output inside collapsed <details> blocks", () => {
    expect(md).toContain("<details>");
    expect(md).toContain("</details>");
    expect(md).toContain("1 failing");
    expect(md).toContain("AssertionError");
  });

  test("fences output that itself contains backticks without breaking the block", () => {
    const report: GateRunReport = {
      ok: false,
      failedGate: "x",
      results: [
        {
          name: "x",
          command: "c",
          exitCode: 1,
          stdout: "```\nnested fence\n```\n",
          stderr: "",
          timedOut: false,
          passed: false,
          durationMs: 5,
        },
      ],
    };
    const out = renderEvidence(1, report);
    // The wrapping fence must be longer than any backtick run in the content.
    expect(out).toContain("````");
    expect(out).toContain("nested fence");
  });
});

/** In-memory comment store implementing the evidence gateway. */
function gatewayHarness(initial: IssueComment[] = []) {
  let nextId = 1;
  const comments = [...initial];
  const posted: string[] = [];
  const edited: Array<{ id: number; body: string }> = [];
  const gw: EvidenceGateway = {
    async listIssueComments() {
      return comments;
    },
    async postComment(_repo, issueNumber, body) {
      const id = nextId++;
      comments.push({
        authorLogin: "agent",
        body,
        url: `https://x/issues/${issueNumber}#issuecomment-${id}`,
      });
      posted.push(body);
    },
    async editComment(_repo, commentId, body) {
      const c = comments.find((x) => x.url.endsWith(`#issuecomment-${commentId}`));
      if (c) c.body = body;
      edited.push({ id: commentId, body });
    },
  };
  return { gw, comments, posted, edited };
}

describe("upsertEvidenceComment", () => {
  test("posts a fresh comment when none exists for the phase", async () => {
    const h = gatewayHarness();
    await upsertEvidenceComment({
      gh: h.gw,
      repo: "o/r",
      prNumber: 99,
      subIssue: 40,
      report: MIXED,
    });
    expect(h.posted).toHaveLength(1);
    expect(h.edited).toHaveLength(0);
    expect(h.posted[0]).toContain(evidenceMarker(40));
  });

  test("re-runs update the same comment in place rather than posting a duplicate", async () => {
    const h = gatewayHarness();
    await upsertEvidenceComment({
      gh: h.gw,
      repo: "o/r",
      prNumber: 99,
      subIssue: 40,
      report: MIXED,
    });
    await upsertEvidenceComment({
      gh: h.gw,
      repo: "o/r",
      prNumber: 99,
      subIssue: 40,
      report: { ok: true, results: [] },
    });
    expect(h.posted).toHaveLength(1); // still only the original post
    expect(h.edited).toHaveLength(1); // the re-run edited it
    expect(h.comments).toHaveLength(1);
  });

  test("a different phase's evidence gets its own comment", async () => {
    const h = gatewayHarness();
    await upsertEvidenceComment({
      gh: h.gw,
      repo: "o/r",
      prNumber: 99,
      subIssue: 40,
      report: MIXED,
    });
    await upsertEvidenceComment({
      gh: h.gw,
      repo: "o/r",
      prNumber: 99,
      subIssue: 41,
      report: MIXED,
    });
    expect(h.comments).toHaveLength(2);
    expect(h.edited).toHaveLength(0);
  });
});
