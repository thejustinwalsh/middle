/**
 * Standing backlog audit (Epic #143, sub-issue #144) — the recommender-sibling
 * pass. Exercises the real pass against the real `EpicGateway` interface (an
 * in-memory implementation), then the cron pass over a managed-repo registry.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openAndMigrate } from "../src/db.ts";
import { runBacklogAudit, NEEDS_DESIGN_LABEL } from "../src/audit.ts";
import { runAuditCronPass } from "../src/audit-cron.ts";
import type { IssueSummary } from "../src/github.ts";
import { registerManagedRepo, setPausedUntil } from "../src/repo-config.ts";

const GOOD =
  "## Acceptance criteria\n- [ ] `mm foo` serves it; an integration test boots the daemon and GETs `/foo`";
const WEAK = "## Acceptance criteria\n- [ ] it works\n- [ ] unit tests pass";

/** An in-memory GitHub gateway recording label writes. */
function fakeGithub(issues: IssueSummary[]) {
  const labelled: { n: number; label: string }[] = [];
  return {
    labelled,
    listOpenIssues: async () => issues,
    addLabel: async (_repo: string, n: number, label: string) => {
      labelled.push({ n, label });
    },
  };
}

describe("runBacklogAudit", () => {
  test("flags rubric-failing feature issues; passes the good one; skips epics", async () => {
    const gh = fakeGithub([
      { number: 1, title: "Epic", body: WEAK, labels: ["epic"] },
      { number: 2, title: "Weak feature", body: WEAK, labels: ["enhancement"] },
      { number: 3, title: "Good feature", body: GOOD, labels: [] },
    ]);
    const { flagged } = await runBacklogAudit({ repo: "o/r", github: gh });
    expect(flagged).toEqual([2]);
    expect(gh.labelled).toEqual([{ n: 2, label: NEEDS_DESIGN_LABEL }]);
  });

  test("does not re-label an issue already marked needs-design", async () => {
    const gh = fakeGithub([
      { number: 4, title: "Weak", body: WEAK, labels: ["enhancement", "needs-design"] },
    ]);
    const { flagged } = await runBacklogAudit({ repo: "o/r", github: gh });
    expect(flagged).toEqual([]);
    expect(gh.labelled).toEqual([]);
  });

  test("respects the per-pass cap", async () => {
    const many: IssueSummary[] = Array.from({ length: 5 }, (_v, i) => ({
      number: i + 10,
      title: `Weak ${i}`,
      body: WEAK,
      labels: ["enhancement"],
    }));
    const gh = fakeGithub(many);
    const { flagged } = await runBacklogAudit({ repo: "o/r", github: gh, maxFlagsPerPass: 2 });
    expect(flagged).toHaveLength(2);
  });

  test("an addLabel failure is isolated — the sweep continues", async () => {
    const gh = {
      labelled: [] as number[],
      listOpenIssues: async (): Promise<IssueSummary[]> => [
        { number: 1, title: "Weak A", body: WEAK, labels: ["enhancement"] },
        { number: 2, title: "Weak B", body: WEAK, labels: ["enhancement"] },
      ],
      addLabel: async (_repo: string, n: number) => {
        if (n === 1) throw new Error("boom");
        gh.labelled.push(n);
      },
    };
    const { flagged } = await runBacklogAudit({ repo: "o/r", github: gh });
    expect(flagged).toEqual([2]); // #1 failed to label, #2 still flagged
  });
});

describe("runAuditCronPass", () => {
  let db: Database;
  beforeEach(() => {
    db = openAndMigrate(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  test("sweeps managed repos, skips paused ones", async () => {
    registerManagedRepo(db, "o/active", "/active");
    registerManagedRepo(db, "o/paused", "/paused");
    setPausedUntil(db, "o/paused", Number.MAX_SAFE_INTEGER);

    const seen: string[] = [];
    const total = await runAuditCronPass({
      db,
      github: {
        listOpenIssues: async (repo) => {
          seen.push(repo);
          return [{ number: 1, title: "Weak", body: WEAK, labels: ["enhancement"] }];
        },
        addLabel: async () => {},
      },
    });
    expect(seen).toEqual(["o/active"]); // paused repo skipped
    expect(total).toBe(1);
  });
});
