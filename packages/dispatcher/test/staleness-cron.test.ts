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
  const closed: string[] = [];
  return {
    created,
    closed,
    listOpenIssues: async () => open,
    listMergedPrsClosingRefs: async () => merged,
    closeIssue: async (_r: string, ref: string) => {
      closed.push(ref);
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

describe("runStalenessCronPass — spec_path is constrained to the checkout", () => {
  /** Capture console.error during `fn` and return the lines logged. */
  async function captureErrors(fn: () => Promise<unknown>): Promise<string[]> {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.join(" "));
    };
    try {
      await fn();
    } finally {
      console.error = origError;
    }
    return errors;
  }

  test("a `..` traversal spec_path is rejected — the pass never reads outside the checkout", async () => {
    // Plant a spec OUTSIDE the checkout that *would* drift if read, and aim the
    // configured spec_path up-and-over at it. The escape must be refused: no file
    // outside the repo is read, so the per-repo pass fails closed (logs, closes
    // nothing, files nothing) rather than leaking the out-of-checkout content.
    const repo = join(scratch, "escaper");
    writeAt(scratch, "outside-spec.md", "The dashboard lands in Phase 9.");
    writeRepoConfig(repo, `[staleness]\nspec_path = "../outside-spec.md"\n`);
    registerManagedRepo(db, "o/escaper", repo);

    const gh = fakeGithub(
      [{ number: 50, title: "SPA", body: "", labels: ["phase:9"] }],
      [{ number: 88, closes: [50] }],
    );

    let closed = 0;
    const errors = await captureErrors(async () => {
      closed = await runStalenessCronPass({ db, github: gh, globalConfigPath });
    });
    expect(closed).toBe(0); // resolveSpecPath threw before any reconcile work
    expect(gh.created).toEqual([]); // the out-of-checkout drift line was never read
    expect(errors.some((e) => e.includes("o/escaper") && e.includes("pass failed"))).toBe(true);
  });

  test("a deeper `../../` traversal is rejected too", async () => {
    const repo = join(scratch, "deep", "nested");
    mkdirSync(repo, { recursive: true });
    writeAt(scratch, "secret.md", "The dashboard lands in Phase 9.");
    writeRepoConfig(repo, `[staleness]\nspec_path = "../../secret.md"\n`);
    registerManagedRepo(db, "o/deep", repo);

    const gh = fakeGithub(
      [{ number: 50, title: "SPA", body: "", labels: ["phase:9"] }],
      [{ number: 88, closes: [50] }],
    );

    let closed = 0;
    const errors = await captureErrors(async () => {
      closed = await runStalenessCronPass({ db, github: gh, globalConfigPath });
    });
    expect(closed).toBe(0);
    expect(gh.created).toEqual([]);
    expect(errors.some((e) => e.includes("o/deep") && e.includes("pass failed"))).toBe(true);
  });

  test("an absolute spec_path is rejected (the field is repo-relative by contract)", async () => {
    // An absolute path is never intended: `[staleness] spec_path` is documented
    // repo-relative and the config mapper does not tilde-expand it. `join` would
    // otherwise quietly re-root it under the checkout; rejecting is the contract.
    const repo = join(scratch, "absolute");
    const outside = join(scratch, "abs-spec.md");
    writeFileSync(outside, "The dashboard lands in Phase 9.");
    writeRepoConfig(repo, `[staleness]\nspec_path = ${JSON.stringify(outside)}\n`);
    registerManagedRepo(db, "o/absolute", repo);

    const gh = fakeGithub(
      [{ number: 50, title: "SPA", body: "", labels: ["phase:9"] }],
      [{ number: 88, closes: [50] }],
    );

    let closed = 0;
    const errors = await captureErrors(async () => {
      closed = await runStalenessCronPass({ db, github: gh, globalConfigPath });
    });
    expect(closed).toBe(0);
    expect(gh.created).toEqual([]);
    expect(errors.some((e) => e.includes("o/absolute") && e.includes("pass failed"))).toBe(true);
  });

  test("a filename whose segment merely starts with `..` is allowed (not a traversal)", async () => {
    // Regression guard for the boundary check: `..specs` is a literal directory
    // name, not a climb out of the repo. A naive `rel.startsWith("..")` would
    // wrongly reject it; the segment-exact check must let it through and read it.
    const repo = join(scratch, "dotdotname");
    writeRepoConfig(repo, `[staleness]\nspec_path = "..specs/build.md"\n`);
    writeAt(repo, join("..specs", "build.md"), "The dashboard lands in Phase 9.");
    registerManagedRepo(db, "o/dotdotname", repo);

    const gh = fakeGithub(
      [{ number: 50, title: "SPA", body: "", labels: ["phase:9"] }],
      [{ number: 88, closes: [50] }],
    );

    const closed = await runStalenessCronPass({ db, github: gh, globalConfigPath });
    expect(closed).toBe(1); // read succeeded, landed issue closed
    expect(gh.created.map((i) => i.title)).toEqual([
      'chore(spec): reconcile stale "Phase 9" reference',
    ]);
    expect(gh.created[0]!.body).toContain("..specs/build.md");
  });
});
