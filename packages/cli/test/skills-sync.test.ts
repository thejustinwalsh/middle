import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOOTSTRAP_SKILLS_DIR,
  CANONICAL_SKILLS_DIR,
  diffSkills,
  syncSkills,
} from "../src/bootstrap/skills-sync.ts";

let root: string;
let canonical: string;
let mirror: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skills-sync-"));
  canonical = join(root, "canonical");
  mirror = join(root, "mirror");
  mkdirSync(join(canonical, "skill-a/references"), { recursive: true });
  writeFileSync(join(canonical, "skill-a/SKILL.md"), "alpha\n");
  writeFileSync(join(canonical, "skill-a/references/ref.md"), "ref body\n");
  mkdirSync(join(canonical, "skill-b"), { recursive: true });
  writeFileSync(join(canonical, "skill-b/SKILL.md"), "beta\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("syncSkills", () => {
  test("copies every canonical file into the mirror byte-for-byte", () => {
    const result = syncSkills({ canonicalDir: canonical, mirrorDir: mirror, check: false });
    expect(result.inSync).toBe(false); // mirror was empty → changes applied
    expect(readFileSync(join(mirror, "skill-a/SKILL.md"), "utf8")).toBe("alpha\n");
    expect(readFileSync(join(mirror, "skill-a/references/ref.md"), "utf8")).toBe("ref body\n");
    expect(readFileSync(join(mirror, "skill-b/SKILL.md"), "utf8")).toBe("beta\n");
  });

  test("a second sync is a no-op (inSync, no changes)", () => {
    syncSkills({ canonicalDir: canonical, mirrorDir: mirror, check: false });
    const again = syncSkills({ canonicalDir: canonical, mirrorDir: mirror, check: false });
    expect(again.inSync).toBe(true);
    expect(again.changed).toEqual([]);
  });

  test("removes stale files the canonical no longer has", () => {
    syncSkills({ canonicalDir: canonical, mirrorDir: mirror, check: false });
    writeFileSync(join(mirror, "skill-b/STALE.md"), "stale\n");
    const result = syncSkills({ canonicalDir: canonical, mirrorDir: mirror, check: false });
    expect(result.inSync).toBe(false);
    expect(() => readFileSync(join(mirror, "skill-b/STALE.md"))).toThrow();
  });
});

describe("diffSkills / check mode", () => {
  test("check mode reports drift without writing", () => {
    const result = diffSkills({ canonicalDir: canonical, mirrorDir: mirror });
    expect(result.inSync).toBe(false);
    expect(result.changed.length).toBeGreaterThan(0);
    // mirror must not have been created by a check
    expect(() => readFileSync(join(mirror, "skill-a/SKILL.md"))).toThrow();
  });

  test("check mode reports in-sync once synced", () => {
    syncSkills({ canonicalDir: canonical, mirrorDir: mirror, check: false });
    const result = diffSkills({ canonicalDir: canonical, mirrorDir: mirror });
    expect(result.inSync).toBe(true);
    expect(result.changed).toEqual([]);
  });

  test("check mode catches a single-byte edit in the mirror", () => {
    syncSkills({ canonicalDir: canonical, mirrorDir: mirror, check: false });
    writeFileSync(join(mirror, "skill-a/SKILL.md"), "alpha-EDITED\n");
    const result = diffSkills({ canonicalDir: canonical, mirrorDir: mirror });
    expect(result.inSync).toBe(false);
    expect(result.changed).toContain("skill-a/SKILL.md");
  });
});

describe("default repo paths", () => {
  test("the shipped canonical and mirror are in sync", () => {
    const result = diffSkills({ canonicalDir: CANONICAL_SKILLS_DIR, mirrorDir: BOOTSTRAP_SKILLS_DIR });
    expect(result.changed).toEqual([]);
    expect(result.inSync).toBe(true);
  });
});
