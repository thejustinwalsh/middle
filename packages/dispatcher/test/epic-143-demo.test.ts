/**
 * Epic #143 end-to-end demonstration. One named test that proves all three
 * self-auditing systems fire against the scenarios the Epic calls out:
 *
 *  1. A deliberately weak issue (criteria = "unit tests pass") is **flagged** by
 *     the requirements auditor.
 *  2. A feature whose criteria are all unit-level **cannot reach PR-ready**.
 *  3. A merged-but-still-open issue **and** a drifted spec line are **surfaced**
 *     by the anti-staleness reconciliation pass.
 *
 * It drives the real decision paths (`auditIssueBody`, `evaluatePrReady`,
 * `reconcileStaleness`) — not stubs of them.
 */
import { describe, expect, test } from "bun:test";
import { auditIssueBody } from "@middle/core";
import { evaluatePrReady } from "../src/gates/pr-ready.ts";
import { reconcileStaleness, reconcileTaskTitle } from "../src/staleness.ts";
import type { IssueSummary, MergedPrRef, NewIssue } from "../src/github.ts";

describe("Epic #143 — integration-verified requirements + freshness", () => {
  test("1. the requirements auditor flags a deliberately weak issue", () => {
    const weak = "## Acceptance criteria\n- [ ] unit tests pass";
    const finding = auditIssueBody(weak, { title: "Add the widget" });
    expect(finding.pass).toBe(false);
    expect(finding.suggestion).toContain("integration");
  });

  test("2. a unit-only feature cannot reach PR-ready", async () => {
    const body = [
      "## Acceptance criteria",
      "- [ ] `addWidget` returns a Widget (#90)",
      "- [ ] unit tests pass (https://github.com/o/r/actions/runs/1)",
    ].join("\n");
    const decision = await evaluatePrReady({
      body,
      resolveCommentAuthor: async () => null,
    });
    expect(decision.decision).toBe("deny");
    if (decision.decision === "deny") expect(decision.reason).toContain("integration test");

    // ...and with an evidenced integration criterion, it is allowed.
    const fixed =
      body +
      "\n- [ ] `mm widget` serves it; a smoke test boots the daemon and GETs `/widget` — packages/cli/test/daemon-entry.test.ts";
    const allowed = await evaluatePrReady({ body: fixed, resolveCommentAuthor: async () => null });
    expect(allowed).toEqual({ decision: "allow" });
  });

  test("3. reconciliation surfaces a landed-but-open issue and a drifted spec line", async () => {
    const created: NewIssue[] = [];
    const closed: string[] = [];
    const open: IssueSummary[] = [
      { number: 50, title: "Build the widget UI", body: "", labels: ["enhancement", "phase:9"] },
    ];
    const merged: MergedPrRef[] = [{ number: 88, closes: [50] }];
    const result = await reconcileStaleness({
      repo: "o/r",
      github: {
        listOpenIssues: async () => open,
        listMergedPrsClosingRefs: async () => merged,
        closeIssue: async (_r, n) => {
          closed.push(n);
        },
        createIssue: async (_r, issue) => {
          created.push(issue);
          return 900;
        },
      },
      readSpec: () => "The widget UI lands in Phase 9 once the SPA is built.",
      specPath: "planning/middle-management-build-spec.md",
    });

    expect(closed).toEqual(["50"]); // landed-but-open issue closed
    expect(result.drift.map((d) => d.phase)).toEqual([9]); // drifted spec line surfaced
    expect(created.map((i) => i.title)).toEqual([reconcileTaskTitle(9)]); // proposal-first reconcile task
  });
});
