/**
 * The anti-staleness cron pass (Epic #143, sub-issue #146) over the managed-repo
 * registry — reads each repo's spec from its checkout and skips paused repos.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openAndMigrate } from "../src/db.ts";
import { registerManagedRepo, setPausedUntil } from "../src/repo-config.ts";
import { DEFAULT_SPEC_PATH, runStalenessCronPass } from "../src/staleness-cron.ts";
import type { IssueSummary, MergedPrRef, NewIssue } from "../src/github.ts";

let db: Database;
let scratch: string;

beforeEach(() => {
  db = openAndMigrate(":memory:");
  scratch = mkdtempSync(join(tmpdir(), "middle-staleness-cron-"));
});
afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** Write a spec file at the default path under `checkout`. */
function writeSpec(checkout: string, text: string): void {
  const p = join(checkout, DEFAULT_SPEC_PATH);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

function fakeGithub(open: IssueSummary[], merged: MergedPrRef[]) {
  const created: NewIssue[] = [];
  const closed: number[] = [];
  return {
    created,
    closed,
    listOpenIssues: async () => open,
    listMergedPrsClosingRefs: async () => merged,
    closeIssue: async (_r: string, n: number) => {
      closed.push(n);
    },
    createIssue: async (_r: string, issue: NewIssue) => {
      created.push(issue);
      return 999;
    },
  };
}

describe("runStalenessCronPass", () => {
  test("reads the repo's spec from its checkout, closes + flags; skips paused", async () => {
    const active = join(scratch, "active");
    writeSpec(active, "The dashboard lands in Phase 9.");
    registerManagedRepo(db, "o/active", active);
    registerManagedRepo(db, "o/paused", join(scratch, "paused"));
    setPausedUntil(db, "o/paused", Number.MAX_SAFE_INTEGER);

    const seen: string[] = [];
    const gh = fakeGithub(
      [{ number: 50, title: "SPA", body: "", labels: ["phase:9"] }],
      [{ number: 88, closes: [50] }],
    );
    const wrapped = {
      ...gh,
      listOpenIssues: async (repo: string) => {
        seen.push(repo);
        return gh.listOpenIssues();
      },
    };

    const closed = await runStalenessCronPass({ db, github: wrapped });
    expect(seen).toEqual(["o/active"]); // paused repo skipped
    expect(closed).toBe(1);
    expect(gh.created.map((i) => i.title)).toContain(
      'chore(spec): reconcile stale "Phase 9" reference',
    );
  });
});
