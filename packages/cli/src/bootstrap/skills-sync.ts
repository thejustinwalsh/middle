import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

/**
 * Two-copies invariant (build spec → "Repo layout"): `packages/skills/` is the
 * canonical skill source; `packages/cli/src/bootstrap-assets/skills/` is the
 * byte-identical copy `mm init` stamps into target repos. A pre-commit hook
 * (`bun run sync-skills --check`) and `mm doctor` both flag drift between them.
 *
 * Paths resolve from this module's own location so they're stable regardless of
 * the caller's cwd — `mm doctor` checks the *middle source tree*, not the user's
 * repo. This file lives at `packages/cli/src/bootstrap/`.
 */
export const CANONICAL_SKILLS_DIR = join(import.meta.dir, "..", "..", "..", "skills");
export const BOOTSTRAP_SKILLS_DIR = join(import.meta.dir, "..", "bootstrap-assets", "skills");

export type SkillsSyncDirs = {
  canonicalDir: string;
  mirrorDir: string;
};

export type SkillsSyncResult = {
  /** True when the mirror already matched the canonical (nothing to do). */
  inSync: boolean;
  /** Repo-relative skill paths that differed (added, changed, or stale). */
  changed: string[];
};

/** A directory is a "skill" iff it's an immediate subdir of the canonical root. */
function listSkillDirs(canonicalDir: string): string[] {
  if (!existsSync(canonicalDir)) return [];
  return readdirSync(canonicalDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/** Recursively list files under `dir`, returned as paths relative to `dir`. */
function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(relative(dir, abs));
    }
  };
  walk(dir);
  return out;
}

/**
 * Enumerate every (relative) skill file across both trees — the union of files
 * present in the canonical skill dirs and their mirror counterparts. A file
 * present only in the mirror is a stale copy that sync must delete.
 */
function unionSkillFiles(canonicalDir: string, mirrorDir: string): string[] {
  const skills = listSkillDirs(canonicalDir);
  const seen = new Set<string>();
  for (const skill of skills) {
    for (const rel of listFilesRecursive(join(canonicalDir, skill))) {
      seen.add(join(skill, rel));
    }
    for (const rel of listFilesRecursive(join(mirrorDir, skill))) {
      seen.add(join(skill, rel));
    }
  }
  return [...seen].sort();
}

function readOrNull(path: string): Buffer | null {
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  return readFileSync(path);
}

/**
 * Compare the two trees without touching either. Returns the set of skill files
 * that differ — present on one side only, or differing bytes.
 */
export function diffSkills(dirs: SkillsSyncDirs): SkillsSyncResult {
  const changed: string[] = [];
  for (const rel of unionSkillFiles(dirs.canonicalDir, dirs.mirrorDir)) {
    const src = readOrNull(join(dirs.canonicalDir, rel));
    const dst = readOrNull(join(dirs.mirrorDir, rel));
    if (src === null || dst === null || !src.equals(dst)) changed.push(rel);
  }
  return { inSync: changed.length === 0, changed };
}

/**
 * Make the mirror byte-identical to the canonical: copy added/changed files and
 * delete stale ones. With `check: true` this is a pure diff (writes nothing) —
 * the mode the pre-commit hook and `mm doctor` use.
 */
export function syncSkills(dirs: SkillsSyncDirs & { check: boolean }): SkillsSyncResult {
  const result = diffSkills(dirs);
  if (dirs.check || result.inSync) return result;

  for (const rel of result.changed) {
    const srcPath = join(dirs.canonicalDir, rel);
    const dstPath = join(dirs.mirrorDir, rel);
    const src = readOrNull(srcPath);
    if (src === null) {
      // Stale in the mirror — the canonical no longer has it.
      rmSync(dstPath, { force: true });
    } else {
      mkdirSync(dirname(dstPath), { recursive: true });
      writeFileSync(dstPath, src);
    }
  }
  return result;
}
