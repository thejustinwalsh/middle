import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAndMigrate } from "../src/db.ts";
import {
  classifyDivergence,
  classifyMergeability,
  type DivergenceGateway,
  getDivergenceState,
  type MergeabilityView,
  parseEpicFromHeadRef,
  recordDivergenceState,
  worktreePathFor,
} from "../src/reconcilers/pr-divergence.ts";

let scratch: string;
let db: Database;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "middle-pr-div-"));
  db = openAndMigrate(join(scratch, "db.sqlite3"));
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const REPO = "thejustinwalsh/middle";

/** A gateway stub returning a fixed mergeability view, recording calls. */
function makeGateway(
  responses: Record<number, MergeabilityView | null>,
): DivergenceGateway & { calls: number } {
  const g = {
    calls: 0,
    async getMergeability(_repo: string, prNumber: number) {
      g.calls++;
      return responses[prNumber] ?? null;
    },
  };
  return g;
}

describe("classifyMergeability", () => {
  test("DIRTY → CONFLICTED regardless of mergeable", () => {
    expect(classifyMergeability({ mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" })).toBe(
      "CONFLICTED",
    );
    expect(classifyMergeability({ mergeStateStatus: "DIRTY", mergeable: "UNKNOWN" })).toBe(
      "CONFLICTED",
    );
  });

  test("BEHIND → BEHIND", () => {
    expect(classifyMergeability({ mergeStateStatus: "BEHIND", mergeable: "MERGEABLE" })).toBe(
      "BEHIND",
    );
  });

  test("CLEAN + MERGEABLE → CLEAN", () => {
    expect(classifyMergeability({ mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" })).toBe(
      "CLEAN",
    );
  });

  test("CLEAN but not MERGEABLE → UNKNOWN (CI gating, secondary signals)", () => {
    expect(classifyMergeability({ mergeStateStatus: "CLEAN", mergeable: "UNKNOWN" })).toBe(
      "UNKNOWN",
    );
  });

  test("BLOCKED / HAS_HOOKS / UNSTABLE / UNKNOWN → UNKNOWN", () => {
    for (const status of ["BLOCKED", "HAS_HOOKS", "UNSTABLE", "UNKNOWN"]) {
      expect(classifyMergeability({ mergeStateStatus: status, mergeable: "MERGEABLE" })).toBe(
        "UNKNOWN",
      );
    }
  });

  test("a null view (PR doesn't exist) → UNKNOWN", () => {
    expect(classifyMergeability(null)).toBe("UNKNOWN");
  });

  test("missing fields → UNKNOWN (legacy fixtures don't tip the classifier)", () => {
    expect(classifyMergeability({})).toBe("UNKNOWN");
    expect(classifyMergeability({ mergeStateStatus: "CLEAN" })).toBe("UNKNOWN");
    expect(classifyMergeability({ mergeable: "MERGEABLE" })).toBe("UNKNOWN");
  });
});

describe("classifyDivergence", () => {
  test("classifies BEHIND and persists the row with the supplied clock", async () => {
    const github = makeGateway({
      90: { mergeStateStatus: "BEHIND", mergeable: "MERGEABLE" },
    });
    const now = 1_700_000_000_000;

    expect(await classifyDivergence({ db, github, now: () => now }, REPO, 90)).toBe("BEHIND");

    expect(github.calls).toBe(1);
    expect(getDivergenceState(db, REPO, 90)).toEqual({ state: "BEHIND", classifiedAt: now });
  });

  test("classifies CONFLICTED and overwrites a prior row (upsert keeps the row fresh)", async () => {
    const github = makeGateway({
      90: { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" },
    });

    // Pre-existing stale row from an earlier pass.
    recordDivergenceState(db, REPO, 90, "BEHIND", 1_000);

    expect(await classifyDivergence({ db, github, now: () => 2_000 }, REPO, 90)).toBe("CONFLICTED");
    expect(getDivergenceState(db, REPO, 90)).toEqual({
      state: "CONFLICTED",
      classifiedAt: 2_000,
    });
  });

  test("classifies CLEAN", async () => {
    const github = makeGateway({
      91: { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" },
    });
    expect(await classifyDivergence({ db, github, now: () => 3_000 }, REPO, 91)).toBe("CLEAN");
    expect(getDivergenceState(db, REPO, 91)?.state).toBe("CLEAN");
  });

  test("classifies UNKNOWN for a PR with no mergeability view (gone / 404)", async () => {
    const github = makeGateway({}); // no entry for prNumber → returns null
    expect(await classifyDivergence({ db, github, now: () => 4_000 }, REPO, 99)).toBe("UNKNOWN");
    expect(getDivergenceState(db, REPO, 99)?.state).toBe("UNKNOWN");
  });
});

describe("parseEpicFromHeadRef", () => {
  test("parses `middle-issue-<N>` to the integer N", () => {
    expect(parseEpicFromHeadRef("middle-issue-32")).toBe(32);
    expect(parseEpicFromHeadRef("middle-issue-1")).toBe(1);
    expect(parseEpicFromHeadRef("middle-issue-12345")).toBe(12345);
  });

  test("a non-managed head ref → null (the helper skips it)", () => {
    expect(parseEpicFromHeadRef("feature/foo")).toBe(null);
    expect(parseEpicFromHeadRef("main")).toBe(null);
    expect(parseEpicFromHeadRef("")).toBe(null);
  });

  test("a malformed managed ref → null (defends against an inadvertent rename)", () => {
    expect(parseEpicFromHeadRef("middle-issue-")).toBe(null);
    expect(parseEpicFromHeadRef("middle-issue-abc")).toBe(null);
    expect(parseEpicFromHeadRef("middle-issue-32.5")).toBe(null);
    // Negative / zero are not valid Epic numbers (issue numbers start at 1).
    expect(parseEpicFromHeadRef("middle-issue-0")).toBe(null);
    expect(parseEpicFromHeadRef("middle-issue--1")).toBe(null);
  });
});

describe("worktreePathFor", () => {
  test("uses <root>/<repo>/issue-<n> — the same layout createWorktree writes", () => {
    expect(worktreePathFor("owner/repo", 32, "/wt-root")).toBe("/wt-root/owner/repo/issue-32");
  });
});

describe("recordDivergenceState", () => {
  test("accepts terminal-ish states (DEMOTED, SKIPPED) written by sibling phases", () => {
    recordDivergenceState(db, REPO, 90, "DEMOTED", 100);
    expect(getDivergenceState(db, REPO, 90)).toEqual({ state: "DEMOTED", classifiedAt: 100 });

    recordDivergenceState(db, REPO, 91, "SKIPPED", 200);
    expect(getDivergenceState(db, REPO, 91)).toEqual({ state: "SKIPPED", classifiedAt: 200 });
  });

  test("the CHECK constraint rejects an out-of-vocabulary state — defends against a reconciler typo", () => {
    expect(() => {
      recordDivergenceState(db, REPO, 90, "BUSTED" as unknown as "CLEAN", 100);
    }).toThrow();
  });

  test("the (repo, pr_number) PK lets the same pr_number coexist across repos", () => {
    recordDivergenceState(db, "owner-a/r", 90, "CLEAN", 100);
    recordDivergenceState(db, "owner-b/r", 90, "BEHIND", 200);
    expect(getDivergenceState(db, "owner-a/r", 90)?.state).toBe("CLEAN");
    expect(getDivergenceState(db, "owner-b/r", 90)?.state).toBe("BEHIND");
  });
});
