import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkModuleIndex,
  claudeMdPathForIndex,
  findIndexFiles,
  parseModuleIndexFrontmatter,
} from "../src/checks/module-index.ts";

const GOOD = `/**
 * @packageDocumentation
 * @module @middle/example
 *
 * One-line purpose.
 *
 * Public surface:
 * - \`thing\` — what it does
 *
 * Where things live:
 * - \`thing.ts\` — the thing
 *
 * Gotchas:
 * - None.
 *
 * claude-md: false
 */
export {};
`;

describe("parseModuleIndexFrontmatter", () => {
  test("accepts a well-formed frontmatter block", () => {
    const result = parseModuleIndexFrontmatter(GOOD);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frontmatter.module).toBe("@middle/example");
      expect(result.frontmatter.claudeMd).toBe(false);
    }
  });

  test("reads claude-md: true", () => {
    const result = parseModuleIndexFrontmatter(GOOD.replace("claude-md: false", "claude-md: true"));
    expect(result.ok && result.frontmatter.claudeMd).toBe(true);
  });

  test("tolerates a leading shebang before the block", () => {
    expect(parseModuleIndexFrontmatter(`#!/usr/bin/env bun\n${GOOD}`).ok).toBe(true);
  });

  test("rejects a file with no leading block comment", () => {
    const result = parseModuleIndexFrontmatter(`export {};\n`);
    expect(result.ok).toBe(false);
  });

  test("rejects a block missing @packageDocumentation", () => {
    const result = parseModuleIndexFrontmatter(GOOD.replace("@packageDocumentation\n * ", ""));
    expect(result.ok).toBe(false);
  });

  test("rejects a block missing the @module tag", () => {
    const result = parseModuleIndexFrontmatter(GOOD.replace("@module @middle/example", "nope"));
    expect(result.ok).toBe(false);
  });

  test("rejects a missing required section", () => {
    const result = parseModuleIndexFrontmatter(GOOD.replace("Gotchas:", "Notes:"));
    expect(result.ok).toBe(false);
  });

  test("rejects a non-boolean claude-md value", () => {
    const result = parseModuleIndexFrontmatter(
      GOOD.replace("claude-md: false", "claude-md: maybe"),
    );
    expect(result.ok).toBe(false);
  });
});

describe("claudeMdPathForIndex", () => {
  test("maps a package's src/index.ts to the package root CLAUDE.md", () => {
    expect(claudeMdPathForIndex("/r/packages/state-issue/src/index.ts")).toBe(
      "/r/packages/state-issue/CLAUDE.md",
    );
  });

  test("maps a nested module's index.ts to its own dir", () => {
    expect(claudeMdPathForIndex("/r/packages/cli/src/bootstrap/index.ts")).toBe(
      "/r/packages/cli/src/bootstrap/CLAUDE.md",
    );
  });
});

describe("checkModuleIndex — flag↔CLAUDE.md consistency", () => {
  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "mm-modindex-"));
    return dir;
  }

  test("flags claude-md: true with no CLAUDE.md", () => {
    const root = scratch();
    try {
      const modDir = join(root, "pkg", "src");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(join(modDir, "index.ts"), GOOD.replace("claude-md: false", "claude-md: true"));
      const { violations } = checkModuleIndex({ packagesDir: root });
      expect(violations).toHaveLength(1);
      expect(violations[0]!.message).toContain("missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("flags claude-md: false with a stray CLAUDE.md", () => {
    const root = scratch();
    try {
      const modDir = join(root, "pkg", "src");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(join(modDir, "index.ts"), GOOD);
      writeFileSync(join(root, "pkg", "CLAUDE.md"), "# local\n");
      const { violations } = checkModuleIndex({ packagesDir: root });
      expect(violations).toHaveLength(1);
      expect(violations[0]!.message).toContain("exists");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("passes when flag and presence agree, and skips bootstrap-assets", () => {
    const root = scratch();
    try {
      const modDir = join(root, "pkg", "src");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(join(modDir, "index.ts"), GOOD);
      // A copy under bootstrap-assets must be ignored, even if malformed.
      const mirror = join(root, "cli", "src", "bootstrap-assets", "skills", "x");
      mkdirSync(mirror, { recursive: true });
      writeFileSync(join(mirror, "index.ts"), "export {};\n");
      const { violations } = checkModuleIndex({ packagesDir: root });
      expect(violations).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("checkModuleIndex — the real middle packages tree", () => {
  test("every src/index.ts(x) carries valid, consistent frontmatter", () => {
    const { violations } = checkModuleIndex();
    expect(violations).toEqual([]);
  });

  test("finds every package's index front door", () => {
    const files = findIndexFiles(join(import.meta.dir, "..", "..", "..", "packages"));
    // The known front doors are all discovered — a partial-scan regression must fail here.
    const names = files.map((f) => f.replace(/^.*[\\/]packages[\\/]/, "packages/"));
    expect(names).toEqual(
      expect.arrayContaining([
        "packages/core/src/index.ts",
        "packages/docs/src/index.ts",
        "packages/cli/src/index.ts",
        "packages/cli/src/bootstrap/index.ts",
        "packages/dispatcher/src/index.ts",
        "packages/dashboard/src/index.ts",
        "packages/state-issue/src/index.ts",
        "packages/adapters/claude/src/index.ts",
        "packages/adapters/codex/src/index.ts",
      ]),
    );
  });
});
