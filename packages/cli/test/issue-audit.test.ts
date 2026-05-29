import { describe, expect, test } from "bun:test";
import { auditIssues, isFeatureIssue, type IssueLike } from "../src/checks/issue-audit.ts";
import { runAuditIssues } from "../src/commands/audit-issues.ts";

const GOOD_BODY =
  "## Acceptance criteria\n- [ ] `mm foo` serves it; an integration test boots the daemon and GETs `/foo`";
const WEAK_BODY = "## Acceptance criteria\n- [ ] it works\n- [ ] unit tests pass";

describe("isFeatureIssue", () => {
  test("epics, docs and chore issues are out of scope", () => {
    expect(isFeatureIssue({ number: 1, title: "x", body: "", labels: ["epic"] })).toBe(false);
    expect(isFeatureIssue({ number: 2, title: "x", body: "", labels: ["documentation"] })).toBe(
      false,
    );
    expect(isFeatureIssue({ number: 3, title: "x", body: "", labels: ["enhancement"] })).toBe(true);
    expect(isFeatureIssue({ number: 4, title: "x", body: "", labels: [] })).toBe(true);
  });
});

describe("auditIssues", () => {
  test("filters to feature issues and applies the rubric", () => {
    const issues: IssueLike[] = [
      { number: 10, title: "Epic", body: WEAK_BODY, labels: ["epic"] },
      { number: 11, title: "Weak feature", body: WEAK_BODY, labels: ["enhancement"] },
      { number: 12, title: "Good feature", body: GOOD_BODY, labels: [] },
    ];
    const reports = auditIssues(issues);
    expect(reports.map((r) => r.number)).toEqual([11, 12]); // epic dropped
    expect(reports.find((r) => r.number === 11)!.finding.pass).toBe(false);
    expect(reports.find((r) => r.number === 12)!.finding.pass).toBe(true);
  });
});

describe("runAuditIssues --issue mode", () => {
  test("flags a weak issue, returns 1, and labels it when --label is set", async () => {
    const labelled: { n: number; label: string }[] = [];
    const code = await runAuditIssues("/repo", {
      issue: 11,
      label: true,
      resolveSlug: async () => "owner/name",
      fetchIssue: async (_slug, n) => ({
        number: n,
        title: "Weak feature",
        body: WEAK_BODY,
        labels: ["enhancement"],
      }),
      addLabel: async (_slug, n, label) => {
        labelled.push({ n, label });
      },
      log: () => {},
      errlog: () => {},
    });
    expect(code).toBe(1);
    expect(labelled).toEqual([{ n: 11, label: "needs-design" }]);
  });

  test("a thrown fetch error is handled: returns 1 and logs, not an unhandled rejection", async () => {
    let logged = "";
    const code = await runAuditIssues("/repo", {
      issue: 11,
      resolveSlug: async () => "owner/name",
      fetchIssue: async () => {
        throw new Error("gh blew up");
      },
      log: () => {},
      errlog: (m) => {
        logged = m;
      },
    });
    expect(code).toBe(1);
    expect(logged).toContain("failed to fetch");
    expect(logged).toContain("gh blew up");
  });

  test("a label-application failure is surfaced (logged) but does not crash the command", async () => {
    // `addLabelDefault` now throws on a non-zero `gh` exit so a failure can't be
    // logged as applied; the command catches it, logs to errlog, and still
    // returns the audit verdict (1 for a failing issue) rather than rejecting.
    let labelLogged = false;
    let errLogged = "";
    const code = await runAuditIssues("/repo", {
      issue: 11,
      label: true,
      resolveSlug: async () => "owner/name",
      fetchIssue: async (_slug, n) => ({
        number: n,
        title: "Weak feature",
        body: WEAK_BODY,
        labels: ["enhancement"],
      }),
      addLabel: async () => {
        throw new Error("gh issue edit --add-label failed");
      },
      log: (m) => {
        if (m.includes("labelled")) labelLogged = true;
      },
      errlog: (m) => {
        errLogged = m;
      },
    });
    expect(code).toBe(1);
    expect(labelLogged).toBe(false); // never logged as applied
    expect(errLogged).toContain("failed to label");
    expect(errLogged).toContain("--add-label failed");
  });

  test("a passing issue returns 0 and is never labelled", async () => {
    const labelled: number[] = [];
    const code = await runAuditIssues("/repo", {
      issue: 12,
      label: true,
      resolveSlug: async () => "owner/name",
      fetchIssue: async (_slug, n) => ({ number: n, title: "Good", body: GOOD_BODY, labels: [] }),
      addLabel: async (_slug, n) => {
        labelled.push(n);
      },
      log: () => {},
      errlog: () => {},
    });
    expect(code).toBe(0);
    expect(labelled).toEqual([]);
  });
});

describe("runAuditIssues backlog mode", () => {
  test("returns 1 when any feature issue fails; labels only failures", async () => {
    const labelled: number[] = [];
    const code = await runAuditIssues("/repo", {
      label: true,
      resolveSlug: async () => "owner/name",
      listOpenIssues: async () => [
        { number: 10, title: "Epic", body: WEAK_BODY, labels: ["epic"] },
        { number: 11, title: "Weak", body: WEAK_BODY, labels: ["enhancement"] },
        { number: 12, title: "Good", body: GOOD_BODY, labels: [] },
      ],
      addLabel: async (_slug, n) => {
        labelled.push(n);
      },
      log: () => {},
      errlog: () => {},
    });
    expect(code).toBe(1);
    expect(labelled).toEqual([11]); // epic excluded, good passes
  });
});
