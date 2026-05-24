import { describe, expect, test } from "bun:test";
import type { IssueComment, PlanCommentReader } from "../../src/gates/plan-comment.ts";
import { verifyPlanComment } from "../../src/gates/plan-comment.ts";

/** An in-memory PlanCommentReader returning a fixed comment list. */
function reader(comments: IssueComment[]): PlanCommentReader {
  return {
    async listIssueComments() {
      return comments;
    },
  };
}

const PLAN = `# Issue #27: Skill enforcement gates

## Goal
Turn principles into enforced gates.

## Phases
1. plan-comment guard
`;

describe("verifyPlanComment", () => {
  test("passes when a comment by the agent's account contains the plan body", async () => {
    const result = await verifyPlanComment({
      gh: reader([{ authorLogin: "agentbot", body: PLAN, url: "u1" }]),
      repo: "o/r",
      epicNumber: 27,
      planBody: PLAN,
      agentLogin: "agentbot",
    });
    expect(result.ok).toBe(true);
  });

  test("fails with the exact reason when no comment contains the plan body", async () => {
    const result = await verifyPlanComment({
      gh: reader([{ authorLogin: "agentbot", body: "lgtm, shipping", url: "u1" }]),
      repo: "o/r",
      epicNumber: 27,
      planBody: PLAN,
      agentLogin: "agentbot",
    });
    expect(result).toEqual({
      ok: false,
      reason: "Plan-comment guard: no plan comment found on Epic #27",
    });
  });

  test("fails when the plan body was posted by a different account", async () => {
    const result = await verifyPlanComment({
      gh: reader([{ authorLogin: "someone-else", body: PLAN, url: "u1" }]),
      repo: "o/r",
      epicNumber: 27,
      planBody: PLAN,
      agentLogin: "agentbot",
    });
    expect(result.ok).toBe(false);
  });

  test("tolerates CRLF and trailing-whitespace differences between comment and plan", async () => {
    const crlf = `${PLAN.replace(/\n/g, "\r\n")}\r\n\r\n`;
    const result = await verifyPlanComment({
      gh: reader([{ authorLogin: "agentbot", body: crlf, url: "u1" }]),
      repo: "o/r",
      epicNumber: 27,
      planBody: PLAN,
      agentLogin: "agentbot",
    });
    expect(result.ok).toBe(true);
  });

  test("matches regardless of author when no agentLogin filter is supplied", async () => {
    const result = await verifyPlanComment({
      gh: reader([{ authorLogin: "whoever", body: `prefix\n\n${PLAN}`, url: "u1" }]),
      repo: "o/r",
      epicNumber: 27,
      planBody: PLAN,
    });
    expect(result.ok).toBe(true);
  });

  test("an empty plan body never vacuously passes", async () => {
    const result = await verifyPlanComment({
      gh: reader([{ authorLogin: "agentbot", body: "anything at all", url: "u1" }]),
      repo: "o/r",
      epicNumber: 27,
      planBody: "   \n  \n",
      agentLogin: "agentbot",
    });
    expect(result.ok).toBe(false);
  });
});
