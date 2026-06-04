import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openAndMigrate } from "@middle/dispatcher/src/db.ts";
import {
  assertNoRepoPathCollision,
  getManagedRepoPath,
  registerManagedRepo,
} from "@middle/dispatcher/src/repo-config.ts";
import type { BootstrapDeps } from "../src/bootstrap/types.ts";
import { runInit } from "../src/commands/init.ts";

// #226 — `mm init` must reject a checkout path already registered to a DIFFERENT
// repo slug, before it scaffolds anything. End-to-end: init repo `acme/a` (file
// mode) in a directory, then a second init that resolves to `acme/b` at the SAME
// directory must exit non-zero with a message naming both repos + the path, and
// the second repo's `.middle/<slug>.toml` must NOT be written.

/** File-mode deps (zero gh calls) resolving a controllable `owner/name` slug. */
function fileDeps(owner: string, name: string): BootstrapDeps {
  const die = (m: string) => () => {
    throw new Error(`gh call '${m}' must not happen in file mode`);
  };
  return {
    isCleanWorktree: async () => true,
    getRemoteUrl: async () => `git@github.com:${owner}/${name}.git`,
    isGhAuthenticated: die("isGhAuthenticated") as () => Promise<boolean>,
    resolveRepoInfo: die("resolveRepoInfo") as () => Promise<never>,
    resolveRepoInfoLocal: async () => ({ owner, name, defaultBranch: "main" }),
    github: {
      ensureStateLabel: die("ensureStateLabel") as () => Promise<void>,
      createStateIssue: die("createStateIssue") as () => Promise<number>,
      closeStateIssue: die("closeStateIssue") as () => Promise<void>,
      findStateIssues: die("findStateIssues") as () => Promise<number[]>,
    },
    now: () => new Date("2026-06-04T12:00:00.000Z"),
  };
}

let dir: string;
let db: Database;
let errors: string[];
let restore: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mm-init-collide-"));
  mkdirSync(join(dir, ".git"));
  db = openAndMigrate(":memory:");
  errors = [];
  const log = spyOn(console, "log").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.join(" "));
  });
  restore = () => {
    log.mockRestore();
    err.mockRestore();
  };
});

afterEach(() => {
  restore();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("mm init — shared-checkout collision guard (#226)", () => {
  test("a second init at the same path with a different slug exits non-zero and writes nothing", async () => {
    // First init: acme/a at `dir` succeeds and registers the path.
    const first = await runInit(dir, {
      deps: fileDeps("acme", "a"),
      epicStore: "file",
      registerRepo: (repo, repoPath) => registerManagedRepo(db, repo, repoPath),
      checkCollision: (repo, repoPath) => assertNoRepoPathCollision(db, repo, repoPath),
    });
    expect(first).toBe(0);
    expect(getManagedRepoPath(db, "acme/a")).not.toBeNull();
    expect(existsSync(join(dir, ".middle", "acme-a.toml"))).toBe(true);

    errors = [];

    // Second init: acme/b at the SAME `dir` must be rejected before scaffolding.
    const second = await runInit(dir, {
      deps: fileDeps("acme", "b"),
      epicStore: "file",
      registerRepo: (repo, repoPath) => registerManagedRepo(db, repo, repoPath),
      checkCollision: (repo, repoPath) => assertNoRepoPathCollision(db, repo, repoPath),
    });

    // Non-zero exit, with an error naming BOTH repos + the shared path.
    expect(second).toBe(1);
    const message = errors.join("\n");
    expect(message).toContain("acme/a");
    expect(message).toContain("acme/b");
    expect(message).toContain(dir);

    // The second repo never got a row, and its `.middle/<slug>.toml` was NOT written.
    expect(getManagedRepoPath(db, "acme/b")).toBeNull();
    expect(existsSync(join(dir, ".middle", "acme-b.toml"))).toBe(false);
  });

  test("re-initializing the SAME slug at the same path is allowed (idempotent, no collision)", async () => {
    const opts = {
      deps: fileDeps("acme", "a"),
      epicStore: "file" as const,
      registerRepo: (repo: string, repoPath: string) => registerManagedRepo(db, repo, repoPath),
      checkCollision: (repo: string, repoPath: string) =>
        assertNoRepoPathCollision(db, repo, repoPath),
    };
    expect(await runInit(dir, opts)).toBe(0);
    expect(await runInit(dir, opts)).toBe(0); // re-init, same slug → no collision
    expect(getManagedRepoPath(db, "acme/a")).not.toBeNull();
  });

  test("--dry-run skips the collision guard (it writes nothing anyway)", async () => {
    // Register acme/a at `dir`, then a dry-run of acme/b at the same path must NOT
    // throw — the guard only fires on the real write path.
    registerManagedRepo(db, "acme/a", dir);
    const code = await runInit(dir, {
      deps: fileDeps("acme", "b"),
      epicStore: "file",
      dryRun: true,
      checkCollision: (repo, repoPath) => assertNoRepoPathCollision(db, repo, repoPath),
    });
    expect(code).toBe(0);
  });
});
