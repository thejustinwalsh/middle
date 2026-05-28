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
/** A global config path that doesn't exist — keeps per-repo config loads hermetic
 *  (they fall back to documented defaults instead of the host's ~/.middle/config). */
let globalConfigPath: string;

beforeEach(() => {
  db = openAndMigrate(":memory:");
  scratch = mkdtempSync(join(tmpdir(), "middle-staleness-cron-"));
  globalConfigPath = join(scratch, "no-such-global.toml");
});
afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** Write a file at `relPath` under `checkout`, creating parent dirs. */
function writeAt(checkout: string, relPath: string, text: string): void {
  const p = join(checkout, relPath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

/** Write a spec file at the default path under `checkout`. */
function writeSpec(checkout: string, text: string): void {
  writeAt(checkout, DEFAULT_SPEC_PATH, text);
}

/** Write a repo's `.middle/config.toml` (the local cache loadConfig reads). */
function writeRepoConfig(checkout: string, toml: string): void {
  writeAt(checkout, join(".middle", "config.toml"), toml);
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

    const closed = await runStalenessCronPass({ db, github: wrapped, globalConfigPath });
    expect(seen).toEqual(["o/active"]); // paused repo skipped
    expect(closed).toBe(1);
    expect(gh.created.map((i) => i.title)).toContain(
      'chore(spec): reconcile stale "Phase 9" reference',
    );
  });

  test("a non-ENOENT spec read error surfaces (not silently treated as missing spec)", async () => {
    // A directory where the spec file is expected makes readFileSync throw EISDIR
    // (not ENOENT). That's a real I/O failure: the pass must log it via its
    // per-repo guard, not swallow it as "no spec" the way an absent file is.
    const repo = join(scratch, "broken");
    mkdirSync(join(repo, DEFAULT_SPEC_PATH), { recursive: true }); // spec path is a DIR
    registerManagedRepo(db, "o/broken", repo);

    const gh = fakeGithub(
      [{ number: 50, title: "SPA", body: "", labels: ["phase:9"] }],
      [{ number: 88, closes: [50] }],
    );

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.join(" "));
    };
    try {
      await expect(
        runStalenessCronPass({ db, github: gh, globalConfigPath }),
      ).resolves.toBeNumber();
    } finally {
      console.error = origError;
    }
    expect(errors.some((e) => e.includes("o/broken") && e.includes("pass failed"))).toBe(true);
  });
});

describe("runStalenessCronPass — per-repo spec path", () => {
  test("a repo's [staleness] spec_path points the drift check at a non-default location", async () => {
    // The real integration path (AC2): a managed repo whose config.toml puts the
    // spec somewhere other than DEFAULT_SPEC_PATH. The pass must read that file,
    // detect the drift, and name the configured path in the reconcile task — proving
    // the spec_path flowed end-to-end (config → readSpec → reconcileStaleness body),
    // not merely that the config loader returns a string.
    const repo = join(scratch, "custom");
    writeRepoConfig(repo, `[staleness]\nspec_path = "docs/build-spec.md"\n`);
    writeAt(repo, join("docs", "build-spec.md"), "The dashboard lands in Phase 9.");
    // A decoy at the DEFAULT path with a *different* phase — if resolution wrongly
    // fell back to the default, we'd see Phase 4, not Phase 9.
    writeSpec(repo, "The CLI ships in Phase 4.");
    registerManagedRepo(db, "o/custom", repo);

    const gh = fakeGithub(
      [{ number: 50, title: "SPA", body: "", labels: ["phase:9"] }],
      [{ number: 88, closes: [50] }],
    );

    const closed = await runStalenessCronPass({ db, github: gh, globalConfigPath });
    expect(closed).toBe(1);
    expect(gh.created.map((i) => i.title)).toEqual([
      'chore(spec): reconcile stale "Phase 9" reference',
    ]);
    // The configured path — not the default — is named in the reconcile task body.
    expect(gh.created[0]!.body).toContain("docs/build-spec.md");
    expect(gh.created[0]!.body).not.toContain(DEFAULT_SPEC_PATH);
  });

  test("a repo with no configured spec_path falls back to the default path", async () => {
    const repo = join(scratch, "defaulted");
    // config.toml exists but declares no [staleness] spec_path → default convention.
    writeRepoConfig(repo, `[repo]\nowner = "o"\nname = "defaulted"\n`);
    writeSpec(repo, "The dashboard lands in Phase 9.");
    registerManagedRepo(db, "o/defaulted", repo);

    const gh = fakeGithub(
      [{ number: 50, title: "SPA", body: "", labels: ["phase:9"] }],
      [{ number: 88, closes: [50] }],
    );

    const closed = await runStalenessCronPass({ db, github: gh, globalConfigPath });
    expect(closed).toBe(1);
    expect(gh.created[0]!.body).toContain(DEFAULT_SPEC_PATH);
  });

  test("a repo with no spec file still reconciles landed issues (no drift)", async () => {
    const repo = join(scratch, "nospec"); // no spec file written anywhere
    registerManagedRepo(db, "o/nospec", repo);

    const gh = fakeGithub(
      [{ number: 50, title: "SPA", body: "", labels: ["phase:9"] }],
      [{ number: 88, closes: [50] }],
    );

    const closed = await runStalenessCronPass({ db, github: gh, globalConfigPath });
    expect(closed).toBe(1); // landed issue still closed
    expect(gh.created).toEqual([]); // no spec → no drift check → no reconcile task
  });
});
