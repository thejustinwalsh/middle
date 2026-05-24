import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTsdocCoverage } from "../src/checks/tsdoc-coverage.ts";

// The coverage check is advisory; these tests verify the analyzer reasons
// correctly about doc comments and re-export aliases, not that the real tree is
// fully documented.

describe("checkTsdocCoverage", () => {
  function scratchPackage(indexBody: string, extra: Record<string, string> = {}): string {
    const root = mkdtempSync(join(tmpdir(), "mm-tsdoc-"));
    const src = join(root, "pkg", "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "index.ts"), indexBody);
    for (const [name, body] of Object.entries(extra)) {
      writeFileSync(join(src, name), body);
    }
    return root;
  }

  test("counts a documented local export as documented", () => {
    const root = scratchPackage(
      `/** Adds two numbers. */\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n`,
    );
    try {
      const report = checkTsdocCoverage({ packagesDir: root });
      expect(report.totalExports).toBe(1);
      expect(report.undocumented).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("flags an undocumented local export", () => {
    const root = scratchPackage(`export const VALUE = 1;\n`);
    try {
      const report = checkTsdocCoverage({ packagesDir: root });
      expect(report.totalExports).toBe(1);
      expect(report.undocumented.map((u) => u.name)).toEqual(["VALUE"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolves a re-export to the original declaration's doc comment", () => {
    const root = scratchPackage(`export { add } from "./math.ts";\n`, {
      "math.ts": `/** Adds two numbers. */\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n`,
    });
    try {
      const report = checkTsdocCoverage({ packagesDir: root });
      expect(report.undocumented).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a bare `export {}` module contributes no exports", () => {
    const root = scratchPackage(`export {};\n`);
    try {
      const report = checkTsdocCoverage({ packagesDir: root });
      expect(report.totalExports).toBe(0);
      expect(report.undocumented).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("analyzes the real middle tree without throwing", () => {
    const report = checkTsdocCoverage();
    expect(report.totalExports).toBeGreaterThan(0);
    // Advisory: we don't assert full coverage, just that the report is coherent.
    expect(report.undocumented.length).toBeLessThanOrEqual(report.totalExports);
  });
});
