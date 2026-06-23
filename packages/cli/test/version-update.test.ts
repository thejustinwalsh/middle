import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";

/**
 * Tests for `mm version` git-provenance enrichment and `mm update` self-update.
 *
 * All git/bun spawns are injected so tests run without touching a real repo.
 */

// ---------------------------------------------------------------------------
// version provenance helpers
// ---------------------------------------------------------------------------

import { resolveCliRoot, resolveGitProvenance, formatVersion } from "../src/commands/version.ts";
import { runUpdate } from "../src/commands/update.ts";

/** Canonical repo root for integration tests (packages/cli/test → ../../..). */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

// ---------------------------------------------------------------------------
// resolveCliRoot
// ---------------------------------------------------------------------------

describe("resolveCliRoot", () => {
  test("walking up from a known path inside the repo finds a .git dir", async () => {
    // Walk from the CLI src dir — it IS inside a git repo in the test environment.
    const root = await resolveCliRoot(join(REPO_ROOT, "packages", "cli", "src"));
    expect(root).toBeTruthy();
    // The resolved root should be the repo root (contains packages/).
    expect(root).toBe(REPO_ROOT);
  });

  test("returns null when no .git is found (walks past filesystem root)", async () => {
    // /proc/1 is unlikely to ever have a .git above it.
    const root = await resolveCliRoot("/proc/1");
    expect(root).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveGitProvenance
// ---------------------------------------------------------------------------

describe("resolveGitProvenance", () => {
  test("happy path: returns sha, branch, and dirty=false on a clean tree", async () => {
    const prov = await resolveGitProvenance("/fake/root", {
      spawnGit: async (args) => {
        if (args.includes("rev-parse") && args.includes("--short")) {
          return { stdout: "abc1234\n", exitCode: 0 };
        }
        if (args.includes("branch")) {
          return { stdout: "main\n", exitCode: 0 };
        }
        if (args.includes("status")) {
          return { stdout: "", exitCode: 0 }; // empty = clean
        }
        return { stdout: "", exitCode: 0 };
      },
    });
    expect(prov).toEqual({ sha: "abc1234", branch: "main", dirty: false });
  });

  test("dirty=true when status --porcelain has output", async () => {
    const prov = await resolveGitProvenance("/fake/root", {
      spawnGit: async (args) => {
        if (args.includes("rev-parse")) return { stdout: "abc1234\n", exitCode: 0 };
        if (args.includes("branch")) return { stdout: "main\n", exitCode: 0 };
        if (args.includes("status"))
          return { stdout: " M packages/cli/src/index.ts\n", exitCode: 0 };
        return { stdout: "", exitCode: 0 };
      },
    });
    expect(prov).not.toBeNull();
    expect(prov!.dirty).toBe(true);
  });

  test("returns null when git rev-parse fails (not a git repo)", async () => {
    const prov = await resolveGitProvenance("/fake/root", {
      spawnGit: async () => ({ stdout: "", exitCode: 128 }),
    });
    expect(prov).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatVersion
// ---------------------------------------------------------------------------

describe("formatVersion", () => {
  test("with provenance, clean tree → version (sha, branch)", () => {
    expect(formatVersion("0.0.0", { sha: "abc1234", branch: "main", dirty: false })).toBe(
      "mm 0.0.0 (abc1234, main)",
    );
  });

  test("with provenance, dirty tree → version (sha-dirty, branch)", () => {
    expect(formatVersion("0.0.0", { sha: "abc1234", branch: "feat/my-branch", dirty: true })).toBe(
      "mm 0.0.0 (abc1234-dirty, feat/my-branch)",
    );
  });

  test("without provenance (not a git checkout) → mm version only", () => {
    expect(formatVersion("0.0.0", null)).toBe("mm 0.0.0");
  });
});

// ---------------------------------------------------------------------------
// runUpdate — injected spawns
// ---------------------------------------------------------------------------

describe("runUpdate — refuse on dirty tree", () => {
  test("returns non-zero exit and prints a message when tree is dirty", async () => {
    const logs: string[] = [];
    const errs: string[] = [];
    const spyLog = spyOn(console, "log").mockImplementation(
      (...args: unknown[]) => void logs.push(args.join(" ")),
    );
    const spyErr = spyOn(console, "error").mockImplementation(
      (...args: unknown[]) => void errs.push(args.join(" ")),
    );
    let code: number;
    try {
      code = await runUpdate({
        cliRoot: "/fake/repo",
        spawnGit: async (args) => {
          if (args.includes("rev-parse") && args.includes("--abbrev-ref")) {
            return { stdout: "main\n", exitCode: 0 };
          }
          if (args.includes("status")) return { stdout: " M src/index.ts\n", exitCode: 0 };
          return { stdout: "", exitCode: 0 };
        },
        spawnBun: async () => ({ exitCode: 0 }),
      });
    } finally {
      spyLog.mockRestore();
      spyErr.mockRestore();
    }
    expect(code).not.toBe(0);
    const output = [...logs, ...errs].join("\n");
    expect(output).toContain("/fake/repo");
    expect(output).toMatch(/uncommitted changes|dirty/i);
  });
});

describe("runUpdate — refuse when not on main", () => {
  test("returns non-zero exit and prints a message when on a non-main branch", async () => {
    const logs: string[] = [];
    const errs: string[] = [];
    const spyLog = spyOn(console, "log").mockImplementation(
      (...args: unknown[]) => void logs.push(args.join(" ")),
    );
    const spyErr = spyOn(console, "error").mockImplementation(
      (...args: unknown[]) => void errs.push(args.join(" ")),
    );
    let code: number;
    try {
      code = await runUpdate({
        cliRoot: "/fake/repo",
        spawnGit: async (args) => {
          if (args.includes("rev-parse") && args.includes("--abbrev-ref")) {
            return { stdout: "feat/something\n", exitCode: 0 };
          }
          if (args.includes("status")) return { stdout: "", exitCode: 0 }; // clean
          return { stdout: "", exitCode: 0 };
        },
        spawnBun: async () => ({ exitCode: 0 }),
      });
    } finally {
      spyLog.mockRestore();
      spyErr.mockRestore();
    }
    expect(code).not.toBe(0);
    const output = [...logs, ...errs].join("\n");
    expect(output).toContain("feat/something");
    expect(output).toMatch(/branch|update manually/i);
  });
});

describe("runUpdate — happy path", () => {
  test("pulls ff-only, runs bun install, prints new version, returns 0", async () => {
    const gitCalls: string[][] = [];
    const bunCalls: string[][] = [];
    const logs: string[] = [];
    const spyLog = spyOn(console, "log").mockImplementation(
      (...args: unknown[]) => void logs.push(args.join(" ")),
    );
    let code: number;
    try {
      code = await runUpdate({
        cliRoot: "/fake/repo",
        spawnGit: async (args) => {
          gitCalls.push(args);
          if (args.includes("rev-parse") && args.includes("--abbrev-ref")) {
            return { stdout: "main\n", exitCode: 0 };
          }
          if (args.includes("status")) return { stdout: "", exitCode: 0 };
          if (args.includes("--short")) return { stdout: "deadbeef\n", exitCode: 0 };
          if (args.includes("branch")) return { stdout: "main\n", exitCode: 0 };
          // pull --ff-only
          return { stdout: "Already up to date.\n", exitCode: 0 };
        },
        spawnBun: async (args) => {
          bunCalls.push(args);
          return { exitCode: 0 };
        },
      });
    } finally {
      spyLog.mockRestore();
    }
    expect(code).toBe(0);
    // Must have called git pull --ff-only
    const pullCall = gitCalls.find((c) => c.includes("pull") && c.includes("--ff-only"));
    expect(pullCall).toBeTruthy();
    // Must have called bun install
    const bunInstall = bunCalls.find((c) => c.includes("install"));
    expect(bunInstall).toBeTruthy();
    // Must print the new version line
    const output = logs.join("\n");
    expect(output).toMatch(/mm 0\.0\.0/);
  });
});

// ---------------------------------------------------------------------------
// Integration: real CLI entrypoint wire-up
// ---------------------------------------------------------------------------

describe("CLI integration — mm version + mm update --help are wired", () => {
  test("mm version boots the real CLI and prints the version with git provenance", async () => {
    const proc = Bun.spawn(
      ["bun", join(REPO_ROOT, "packages", "cli", "src", "index.ts"), "version"],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    // Must start with "mm 0.0.0" and include a sha+branch component.
    expect(stdout.trim()).toMatch(/^mm 0\.0\.0/);
    // In the repo (git checkout) it should include provenance.
    expect(stdout.trim()).toMatch(/\([\da-f]+-?(dirty)?, [\w/.-]+\)/);
    expect(code).toBe(0);
  });

  test("mm update --help boots the real CLI and confirms the command is registered", async () => {
    const proc = Bun.spawn(
      ["bun", join(REPO_ROOT, "packages", "cli", "src", "index.ts"), "update", "--help"],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(stdout).toContain("update");
    expect(code).toBe(0);
  });
});
