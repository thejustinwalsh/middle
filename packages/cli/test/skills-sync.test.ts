import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("detects and removes an orphaned skill DIRECTORY present only in the mirror", () => {
    syncSkills({ canonicalDir: canonical, mirrorDir: mirror, check: false });
    // A whole skill dir with no canonical counterpart — the case the union over
    // canonical-only dirs missed, silently breaking byte-identity.
    mkdirSync(join(mirror, "skill-orphan"), { recursive: true });
    writeFileSync(join(mirror, "skill-orphan/SKILL.md"), "orphan\n");

    const drift = diffSkills({ canonicalDir: canonical, mirrorDir: mirror });
    expect(drift.inSync).toBe(false);
    expect(drift.changed).toContain("skill-orphan/SKILL.md");

    const result = syncSkills({ canonicalDir: canonical, mirrorDir: mirror, check: false });
    expect(result.inSync).toBe(false);
    expect(() => readFileSync(join(mirror, "skill-orphan/SKILL.md"))).toThrow();
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

describe("excludeNames — protects named skills from deletion", () => {
  test("diffSkills flags a stale mirror-only skill dir absent an excludeNames set", () => {
    // Seed the mirror with a skill the canonical doesn't have.
    mkdirSync(join(mirror, "skill-extra"), { recursive: true });
    writeFileSync(join(mirror, "skill-extra/SKILL.md"), "extra\n");
    // Also populate the canonical so diffSkills has something to union.
    mkdirSync(join(canonical, "skill-a"), { recursive: true });
    writeFileSync(join(canonical, "skill-a/SKILL.md"), "alpha\n");
    const result = diffSkills({ canonicalDir: canonical, mirrorDir: mirror });
    expect(result.inSync).toBe(false);
    expect(result.changed).toContain("skill-extra/SKILL.md");
  });

  test("diffSkills does NOT flag a mirror-only skill dir named in excludeNames", () => {
    // "skill-extra" exists only in the mirror — but is in the exclusion set.
    mkdirSync(join(mirror, "skill-extra"), { recursive: true });
    writeFileSync(join(mirror, "skill-extra/SKILL.md"), "extra\n");
    mkdirSync(join(canonical, "skill-a"), { recursive: true });
    writeFileSync(join(canonical, "skill-a/SKILL.md"), "alpha\n");
    const result = diffSkills({
      canonicalDir: canonical,
      mirrorDir: mirror,
      excludeNames: new Set(["skill-extra"]),
    });
    expect(result.changed).not.toContain("skill-extra/SKILL.md");
  });

  test("syncSkills does not delete a mirror-only skill dir named in excludeNames", () => {
    // Sync an initial state.
    syncSkills({ canonicalDir: canonical, mirrorDir: mirror, check: false });
    // Add an extra skill to the mirror that has no canonical counterpart.
    mkdirSync(join(mirror, "skill-extra"), { recursive: true });
    writeFileSync(join(mirror, "skill-extra/SKILL.md"), "extra\n");
    // Sync again with the exclusion — skill-extra must survive.
    syncSkills({
      canonicalDir: canonical,
      mirrorDir: mirror,
      check: false,
      excludeNames: new Set(["skill-extra"]),
    });
    expect(readFileSync(join(mirror, "skill-extra/SKILL.md"), "utf8")).toBe("extra\n");
  });

  test("syncSkills still reports a stale file IN a non-excluded skill as changed", () => {
    syncSkills({ canonicalDir: canonical, mirrorDir: mirror, check: false });
    writeFileSync(join(mirror, "skill-a/SKILL.md"), "EDITED\n");
    const result = syncSkills({
      canonicalDir: canonical,
      mirrorDir: mirror,
      check: false,
      excludeNames: new Set(["skill-extra"]),
    });
    expect(result.inSync).toBe(false);
    expect(result.changed).toContain("skill-a/SKILL.md");
  });
});

describe("default repo paths", () => {
  test("the shipped canonical and mirror are in sync", () => {
    const result = diffSkills({
      canonicalDir: CANONICAL_SKILLS_DIR,
      mirrorDir: BOOTSTRAP_SKILLS_DIR,
    });
    expect(result.changed).toEqual([]);
    expect(result.inSync).toBe(true);
  });

  test("the shipped skill set includes the three bootstrapped skills", () => {
    const shipped = readdirSync(CANONICAL_SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(shipped).toContain("implementing-github-issues");
    expect(shipped).toContain("recommending-github-issues");
    expect(shipped).toContain("creating-github-issues");
  });
});
