import { describe, expect, test } from "bun:test";
import type { CommentAuthorResolver } from "../../src/gates/pr-ready.ts";
import {
  commandIsPrReady,
  evaluatePrReady,
  extractCommand,
  parseAcceptanceCriteria,
} from "../../src/gates/pr-ready.ts";

/** Never consulted — used when no criterion carries a deferral. */
const noResolve: CommentAuthorResolver = async () => {
  throw new Error("resolver should not be called");
};

const BODY = `## Summary
Closes #27

## Acceptance criteria
- [ ] All sub-issues closed (#28, #29, #30, #80)
- [x] Plan-comment guard catches a skipped plan (https://github.com/o/r/pull/86/files#diff-abc)
- [ ] \`mm start\` serves the gate; a smoke test boots the daemon and GETs \`/gates/pr-ready\` (packages/dispatcher/test/hook-server-gates.test.ts)
- [ ] Deferred one (deferred: https://github.com/o/r/issues/27#issuecomment-999)

## Verification
some prose, not a criterion
`;

describe("parseAcceptanceCriteria", () => {
  test("extracts the list items under the acceptance-criteria heading only", () => {
    expect(parseAcceptanceCriteria(BODY)).toEqual([
      "All sub-issues closed (#28, #29, #30, #80)",
      "Plan-comment guard catches a skipped plan (https://github.com/o/r/pull/86/files#diff-abc)",
      "`mm start` serves the gate; a smoke test boots the daemon and GETs `/gates/pr-ready` (packages/dispatcher/test/hook-server-gates.test.ts)",
      "Deferred one (deferred: https://github.com/o/r/issues/27#issuecomment-999)",
    ]);
  });

  test("returns [] when there is no acceptance-criteria section", () => {
    expect(parseAcceptanceCriteria("## Summary\nno criteria here\n")).toEqual([]);
  });
});

describe("commandIsPrReady", () => {
  test("matches a bare and an argumented `gh pr ready`", () => {
    expect(commandIsPrReady("gh pr ready")).toBe(true);
    expect(commandIsPrReady("gh pr ready 86")).toBe(true);
  });
  test("does not match other gh commands", () => {
    expect(commandIsPrReady("gh pr view 86")).toBe(false);
    expect(commandIsPrReady("gh pr create --draft")).toBe(false);
  });
});

describe("extractCommand", () => {
  test("reads tool_input.command from a PreToolUse payload", () => {
    expect(extractCommand({ tool_input: { command: "gh pr ready 86" } })).toBe("gh pr ready 86");
  });
  test("returns null when there is no command", () => {
    expect(extractCommand({ tool_input: {} })).toBeNull();
    expect(extractCommand({})).toBeNull();
  });
});

describe("evaluatePrReady", () => {
  test("allows when every criterion carries an evidence link or a non-bot deferral", async () => {
    const resolve: CommentAuthorResolver = async () => ({ login: "thejustinwalsh", isBot: false });
    const result = await evaluatePrReady({ body: BODY, resolveCommentAuthor: resolve });
    expect(result).toEqual({ decision: "allow" });
  });

  test("denies and names the criterion that has no evidence", async () => {
    const body = `## Acceptance criteria
- [ ] Has a link https://example.com/x
- [ ] Bare criterion with no evidence at all
`;
    const result = await evaluatePrReady({ body, resolveCommentAuthor: noResolve });
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toContain("Bare criterion with no evidence at all");
      expect(result.reason).not.toContain("Has a link");
    }
  });

  const INTEGRATION = "`mm foo` serves it; a smoke test boots the daemon and GETs `/foo` (#90)";

  test("a `#N` reference counts as an evidence link", async () => {
    const body = `## Acceptance criteria\n- [ ] All sub-issues closed: #28 #29\n- [ ] ${INTEGRATION}\n`;
    const result = await evaluatePrReady({ body, resolveCommentAuthor: noResolve });
    expect(result).toEqual({ decision: "allow" });
  });

  test("a stakeholder-deferred criterion (non-bot comment) is allowed", async () => {
    const body = `## Acceptance criteria\n- [ ] Punted (deferred: https://github.com/o/r/issues/27#issuecomment-1)\n- [ ] ${INTEGRATION}\n`;
    const resolve: CommentAuthorResolver = async () => ({ login: "maintainer", isBot: false });
    const result = await evaluatePrReady({ body, resolveCommentAuthor: resolve });
    expect(result).toEqual({ decision: "allow" });
  });

  test("a deferral pointing at a bot comment is denied", async () => {
    const body =
      "## Acceptance criteria\n- [ ] Punted (deferred: https://github.com/o/r/issues/27#issuecomment-1)\n";
    const resolve: CommentAuthorResolver = async () => ({
      login: "coderabbitai[bot]",
      isBot: true,
    });
    const result = await evaluatePrReady({ body, resolveCommentAuthor: resolve });
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") expect(result.reason).toContain("Punted");
  });

  test("evidence still satisfies a criterion whose deferral is invalid (OR semantics)", async () => {
    // A criterion carrying BOTH an evidence link and an invalid (bot-authored)
    // deferral must still pass — the invalid deferral must not override the
    // evidence. The integration half is satisfied by the second criterion.
    const body = [
      "## Acceptance criteria",
      "- [ ] Done (https://example.com/x) (deferred: https://github.com/o/r/issues/1#issuecomment-2)",
      "- [ ] `mm start` serves it; a smoke test boots the daemon and GETs `/` — packages/cli/test/daemon-entry.test.ts",
    ].join("\n");
    const resolve: CommentAuthorResolver = async () => ({ login: "middle[bot]", isBot: true });
    const result = await evaluatePrReady({ body, resolveCommentAuthor: resolve });
    expect(result).toEqual({ decision: "allow" });
  });

  test("two bot deferrals and no real evidence is denied (no second-annotation leak)", async () => {
    // The deferral-strip must remove EVERY `(deferred: …)`; if only the first is
    // stripped, the second one's URL would satisfy the evidence check and let a
    // fully-punted, unauthorized criterion through.
    const body =
      "## Acceptance criteria\n- [ ] Punted twice (deferred: https://github.com/o/r/issues/1#issuecomment-1) (deferred: https://github.com/o/r/issues/2#issuecomment-2)\n";
    const resolve: CommentAuthorResolver = async () => ({ login: "middle[bot]", isBot: true });
    const result = await evaluatePrReady({ body, resolveCommentAuthor: resolve });
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") expect(result.reason).toContain("Punted twice");
  });

  test("denies when there is no acceptance-criteria section (no bypass by deletion)", async () => {
    const result = await evaluatePrReady({
      body: "## Summary\nnothing to gate\n",
      resolveCommentAuthor: noResolve,
    });
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") expect(result.reason).toContain("no acceptance criteria");
  });
});

// Integration-verified definition of done (#145): the gate blocks a feature whose
// criteria are all evidenced but none proves an integration test, and allows one
// that does (or that carries a human-authored exemption).
describe("evaluatePrReady — integration evidence", () => {
  test("denies a unit-only PR: every criterion evidenced, none an integration test", async () => {
    const body = [
      "## Acceptance criteria",
      "- [ ] `parseFoo` returns a Foo (#90)",
      "- [ ] unit tests pass (https://github.com/o/r/actions/runs/1)",
    ].join("\n");
    const result = await evaluatePrReady({ body, resolveCommentAuthor: noResolve });
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") expect(result.reason).toContain("integration test");
  });

  test("allows when an integration criterion is evidenced by a named test file", async () => {
    const body = [
      "## Acceptance criteria",
      "- [ ] `parseFoo` returns a Foo (#90)",
      "- [ ] `mm start` serves the SPA; a smoke test boots the daemon and GETs `/` — packages/cli/test/daemon-entry.test.ts",
    ].join("\n");
    const result = await evaluatePrReady({ body, resolveCommentAuthor: noResolve });
    expect(result).toEqual({ decision: "allow" });
  });

  test("a human-authored integration-exempt annotation allows", async () => {
    const body =
      "## Acceptance criteria\n- [ ] pure types only (#90) (integration-exempt: https://github.com/o/r/issues/27#issuecomment-7)";
    const resolve: CommentAuthorResolver = async () => ({ login: "maintainer", isBot: false });
    const result = await evaluatePrReady({ body, resolveCommentAuthor: resolve });
    expect(result).toEqual({ decision: "allow" });
  });

  test("a bot-authored integration-exempt annotation is denied", async () => {
    const body =
      "## Acceptance criteria\n- [ ] pure types only (#90) (integration-exempt: https://github.com/o/r/issues/27#issuecomment-7)";
    const resolve: CommentAuthorResolver = async () => ({ login: "middle[bot]", isBot: true });
    const result = await evaluatePrReady({ body, resolveCommentAuthor: resolve });
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") expect(result.reason).toContain("non-bot human");
  });

  test("an evidenced integration criterion allows even if a stray bot exemption is present", async () => {
    // A real test beats a waiver: the evidenced criterion wins, so the bot-authored
    // exemption annotation never causes a (false) deny.
    const body = [
      "## Acceptance criteria",
      "- [ ] `mm start` serves it; a smoke test boots the daemon and GETs `/` — packages/cli/test/daemon-entry.test.ts",
      "- [ ] note (integration-exempt: https://github.com/o/r/issues/27#issuecomment-9)",
    ].join("\n");
    const resolve: CommentAuthorResolver = async () => ({ login: "middle[bot]", isBot: true });
    const result = await evaluatePrReady({ body, resolveCommentAuthor: resolve });
    expect(result).toEqual({ decision: "allow" });
  });

  test("a deferred integration criterion does not count as integration evidence", async () => {
    const body =
      "## Acceptance criteria\n- [ ] `mm start` serves it; a smoke test boots the daemon and GETs `/` (deferred: https://github.com/o/r/issues/27#issuecomment-1)";
    const resolve: CommentAuthorResolver = async () => ({ login: "maintainer", isBot: false });
    const result = await evaluatePrReady({ body, resolveCommentAuthor: resolve });
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") expect(result.reason).toContain("integration test");
  });
});
