import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BootstrapDeps } from "../src/bootstrap/types.ts";
import { runInit } from "../src/commands/init.ts";

// #135: `mm init` registers the repo in the managed-repo registry (via the
// `registerRepo` seam the CLI entry wires to a db write) so the recommender cron
// finds it cold. These tests pin the seam's contract without touching a db.

function makeFakeDeps(): BootstrapDeps {
  return {
    isCleanWorktree: async () => true,
    getRemoteUrl: async () => "git@github.com:acme/widget.git",
    isGhAuthenticated: async () => true,
    resolveRepoInfo: async () => ({ owner: "acme", name: "widget", defaultBranch: "main" }),
    resolveRepoInfoLocal: async () => ({ owner: "acme", name: "widget", defaultBranch: "main" }),
    github: {
      ensureStateLabel: async () => {},
      createStateIssue: async () => 142,
      closeStateIssue: async () => {},
      findStateIssues: async () => [],
    },
    now: () => new Date("2026-05-25T12:00:00.000Z"),
  };
}

let repo: string;
let silence: () => void;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "mm-init-reg-"));
  mkdirSync(join(repo, ".git"));
  const log = spyOn(console, "log").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation(() => {});
  silence = () => {
    log.mockRestore();
    err.mockRestore();
  };
});
afterEach(() => {
  silence();
  rmSync(repo, { recursive: true, force: true });
});

describe("mm init — managed-repo registration", () => {
  test("registers the slug + resolved checkout path on a successful init", async () => {
    const registered: Array<{ repo: string; repoPath: string }> = [];
    const code = await runInit(repo, {
      deps: makeFakeDeps(),
      registerRepo: (r, p) => registered.push({ repo: r, repoPath: p }),
    });
    expect(code).toBe(0);
    expect(registered).toEqual([{ repo: "acme/widget", repoPath: resolve(repo) }]);
  });

  test("does NOT register under --dry-run (no changes made)", async () => {
    const registered: string[] = [];
    const code = await runInit(repo, {
      deps: makeFakeDeps(),
      dryRun: true,
      registerRepo: (r) => registered.push(r),
    });
    expect(code).toBe(0);
    expect(registered).toEqual([]);
  });

  test("a registry write failure is best-effort — init still succeeds", async () => {
    const code = await runInit(repo, {
      deps: makeFakeDeps(),
      registerRepo: () => {
        throw new Error("db locked");
      },
    });
    expect(code).toBe(0); // the throw is swallowed; init's real work already landed
  });
});
