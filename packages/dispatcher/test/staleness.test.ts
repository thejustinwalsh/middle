/**
 * Anti-staleness reconciliation (Epic #143, sub-issue #146). The unit tests cover
 * the pure drift detector; the integration test runs the **real
 * `reconcileStaleness` pass** against the real `EpicGateway` interface (an
 * in-memory implementation) plus a drifted fixture spec, asserting the close +
 * the drift flag both fire — exercising the orchestration, not a stub of it.
 */
import { describe, expect, test } from "bun:test";
import { detectSpecDrift, reconcileStaleness, reconcileTaskTitle } from "../src/staleness.ts";
import type { IssueSummary, MergedPrRef, NewIssue } from "../src/github.ts";

describe("detectSpecDrift", () => {
  const SPEC = [
    "Phase 8 is done.",
    "The dashboard UI lands in Phase 9 once the SPA is built.",
    "Persistence will ship in phase 12.",
    "Some unrelated prose about phase 9 with no future verb.",
  ].join("\n");

  test("flags future-phase lines whose phase has merged", () => {
    const drift = detectSpecDrift(SPEC, new Set([9]));
    expect(drift).toHaveLength(1);
    expect(drift[0]!.phase).toBe(9);
    expect(drift[0]!.lineNumber).toBe(2);
  });

  test("does not flag a future phase that has not merged", () => {
    expect(detectSpecDrift(SPEC, new Set([12]))).toHaveLength(1); // only phase 12
    expect(detectSpecDrift(SPEC, new Set())).toHaveLength(0);
  });

  test("matches the verb-less 'planned for phase N' phrasing", () => {
    const drift = detectSpecDrift("This work is planned for Phase 7 after review.", new Set([7]));
    expect(drift.map((d) => d.phase)).toEqual([7]);
  });
});

/** An in-memory gateway recording closes + created issues. */
function fakeGithub(opts: { open: IssueSummary[]; merged: MergedPrRef[] }) {
  const closed: { ref: string; comment: string }[] = [];
  const created: NewIssue[] = [];
  let nextNumber = 1000;
  return {
    closed,
    created,
    listOpenIssues: async () => opts.open,
    listMergedPrsClosingRefs: async () => opts.merged,
    closeIssue: async (_repo: string, ref: string, comment: string) => {
      closed.push({ ref, comment });
    },
    createIssue: async (_repo: string, issue: NewIssue) => {
      created.push(issue);
      return ++nextNumber;
    },
  };
}

describe("reconcileStaleness (integration — real pass, in-memory gateway)", () => {
  test("closes a landed-but-open issue and files a drift task for its phase", async () => {
    const gh = fakeGithub({
      open: [
        {
          number: 50,
          title: "Build the dashboard SPA",
          body: "",
          labels: ["enhancement", "phase:9"],
        },
        { number: 51, title: "Unrelated open issue", body: "", labels: ["phase:12"] },
      ],
      merged: [{ number: 88, closes: [50] }], // PR #88 landed, but #50 is still open
    });
    const spec =
      "The dashboard UI lands in Phase 9 once the SPA is built.\nPhase 12 will ship later.";

    const result = await reconcileStaleness({
      repo: "o/r",
      github: gh,
      readSpec: () => spec,
      specPath: "planning/spec.md",
    });

    // Close fired, with an evidence comment naming the merged PR.
    expect(result.closed).toEqual([50]);
    expect(gh.closed).toHaveLength(1);
    expect(gh.closed[0]!.comment).toContain("#88");

    // Drift flag fired: phase 9 merged (the closed issue's label) and the spec still calls it future.
    expect(result.drift.map((d) => d.phase)).toEqual([9]);
    expect(gh.created).toHaveLength(1);
    expect(gh.created[0]!.title).toBe(reconcileTaskTitle(9));
    expect(result.filed).toHaveLength(1);
    // Phase 12 hasn't merged (only #50/phase:9 landed) → not flagged.
    expect(result.drift.some((d) => d.phase === 12)).toBe(false);
  });

  test("does not close an issue no merged PR references, and dedupes an existing reconcile task", async () => {
    const gh = fakeGithub({
      open: [
        { number: 50, title: "Landed", body: "", labels: ["phase:9"] },
        // A reconcile task for phase 9 is already open → don't file a duplicate.
        { number: 60, title: reconcileTaskTitle(9), body: "", labels: ["housekeeping"] },
        { number: 70, title: "Still in progress", body: "", labels: ["phase:9"] },
      ],
      merged: [{ number: 88, closes: [50] }],
    });
    const result = await reconcileStaleness({
      repo: "o/r",
      github: gh,
      readSpec: () => "Lands in Phase 9.",
      specPath: "planning/spec.md",
    });
    expect(result.closed).toEqual([50]); // #70 not referenced by any merged PR → left open
    expect(result.drift.map((d) => d.phase)).toEqual([9]);
    expect(gh.created).toHaveLength(0); // deduped against the existing task
    expect(result.filed).toHaveLength(0);
  });

  test("maxPerPass caps the TOTAL of closes + filed tasks, not each bucket", async () => {
    // One close AND one drift are both available; with maxPerPass=1 the single
    // shared budget is spent on the close, leaving nothing to file a task with.
    const gh = fakeGithub({
      open: [{ number: 50, title: "Landed", body: "", labels: ["phase:9"] }],
      merged: [{ number: 88, closes: [50] }],
    });
    const result = await reconcileStaleness({
      repo: "o/r",
      github: gh,
      readSpec: () => "The dashboard lands in Phase 9.",
      specPath: "planning/spec.md",
      maxPerPass: 1,
    });
    expect(result.closed).toEqual([50]); // budget spent here
    expect(result.drift.map((d) => d.phase)).toEqual([9]); // drift still *detected*
    expect(result.filed).toEqual([]); // …but no budget left to file it
    expect(gh.created).toHaveLength(0);
    expect(result.closed.length + result.filed.length).toBeLessThanOrEqual(1);
  });

  test("no spec → still reconciles landed issues, no drift", async () => {
    const gh = fakeGithub({
      open: [{ number: 50, title: "Landed", body: "", labels: ["phase:9"] }],
      merged: [{ number: 88, closes: [50] }],
    });
    const result = await reconcileStaleness({
      repo: "o/r",
      github: gh,
      readSpec: () => null,
      specPath: "planning/spec.md",
    });
    expect(result.closed).toEqual([50]);
    expect(result.drift).toHaveLength(0);
    expect(result.filed).toHaveLength(0);
  });
});
