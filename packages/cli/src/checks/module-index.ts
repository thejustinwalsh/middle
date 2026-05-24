import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

/**
 * @packageDocumentation
 * @module @middle/cli/checks
 *
 * The module-index frontmatter check: every `src/index.ts(x)` under `packages/`
 * must open with a bespoke frontmatter TSDoc block (#92) that doubles as the
 * `@packageDocumentation` comment TypeDoc consumes (#93), and whose `claude-md`
 * flag deterministically drives whether the module has a nested `CLAUDE.md`
 * (#94). This is the single source of truth for that decision — agents read the
 * flag, they never re-derive it.
 *
 * Public surface:
 * - `checkModuleIndex` — scan a packages tree, return frontmatter violations
 * - `parseModuleIndexFrontmatter` — parse one file's leading block (testable)
 * - `findIndexFiles`, `claudeMdPathForIndex` — the scan + path-mapping helpers
 * - `PACKAGES_DIR` — middle's own packages root, resolved from this module
 *
 * Where things live:
 * - this file — the whole check (no external deps beyond `node:fs`/`node:path`)
 *
 * Gotchas:
 * - Paths resolve from this module's location so the check inspects the *middle
 *   source tree*, like the skills-drift check — not the cwd's repo.
 *
 * claude-md: false
 */

/** middle's own `packages/` root, resolved from this file's location. */
export const PACKAGES_DIR = join(import.meta.dir, "..", "..", "..");

/** Directory names never descended into when scanning for index files. */
const SKIP_DIRS = new Set(["node_modules", "bootstrap-assets", "dist", ".git"]);

/** The three section headers a well-formed frontmatter block must carry. */
const REQUIRED_SECTIONS = ["Public surface:", "Where things live:", "Gotchas:"] as const;

/** One convention breach found for a scanned index module: which file, and why. */
export type ModuleIndexViolation = {
  /** Path relative to the scanned packages root. */
  file: string;
  /** Human-readable reason the file fails the convention. */
  message: string;
};

/** The frontmatter values parsed out of a well-formed module-index block. */
export type ModuleIndexFrontmatter = {
  /** The `@module <name>` value. */
  module: string;
  /** The `claude-md:` flag value — the single source of truth for nested `CLAUDE.md` presence. */
  claudeMd: boolean;
};

/** Recursively collect every `index.ts`/`index.tsx` under `dir`. */
export function findIndexFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(current, entry.name));
      } else if (entry.isFile() && (entry.name === "index.ts" || entry.name === "index.tsx")) {
        out.push(join(current, entry.name));
      }
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Where a module's nested `CLAUDE.md` lives, given its index file: the index's
 * own directory — except when that directory is `src`, where it's the parent
 * (so a package's `src/index.ts` maps to `<package>/CLAUDE.md`, while a nested
 * `bootstrap/index.ts` maps to `bootstrap/CLAUDE.md`).
 */
export function claudeMdPathForIndex(indexFile: string): string {
  const dir = dirname(indexFile);
  const moduleRoot = basename(dir) === "src" ? dirname(dir) : dir;
  return join(moduleRoot, "CLAUDE.md");
}

/** Isolate the leading `/** … *\/` block, skipping a shebang + blank lines. */
function leadingBlockComment(source: string): string | null {
  let s = source;
  if (s.startsWith("#!")) {
    const nl = s.indexOf("\n");
    s = nl === -1 ? "" : s.slice(nl + 1);
  }
  s = s.replace(/^\s+/, "");
  if (!s.startsWith("/**")) return null;
  const end = s.indexOf("*/");
  if (end === -1) return null;
  return s.slice(0, end + 2);
}

/**
 * Parse a file's source into its module-index frontmatter, or return the reason
 * it is malformed. The leading block must carry `@packageDocumentation`, a
 * `@module <name>`, the three required section headers, and a `claude-md:`
 * boolean — the contract the check enforces.
 */
export function parseModuleIndexFrontmatter(
  source: string,
): { ok: true; frontmatter: ModuleIndexFrontmatter } | { ok: false; reason: string } {
  const block = leadingBlockComment(source);
  if (block === null) {
    return { ok: false, reason: "missing leading module-index frontmatter (a `/** … */` block)" };
  }
  if (!block.includes("@packageDocumentation")) {
    return { ok: false, reason: "frontmatter missing `@packageDocumentation` tag" };
  }
  const moduleMatch = block.match(/@module\s+(\S+)/);
  if (!moduleMatch) {
    return { ok: false, reason: "frontmatter missing `@module <name>` tag" };
  }
  const missingSection = REQUIRED_SECTIONS.find((s) => !block.includes(s));
  if (missingSection) {
    return { ok: false, reason: `frontmatter missing required \`${missingSection}\` section` };
  }
  const flagMatch = block.match(/claude-md:\s*(true|false)\b/);
  if (!flagMatch) {
    return {
      ok: false,
      reason: "frontmatter missing a `claude-md:` flag (must be exactly `true` or `false`)",
    };
  }
  return {
    ok: true,
    frontmatter: { module: moduleMatch[1]!, claudeMd: flagMatch[1] === "true" },
  };
}

/**
 * Scan every `index.ts(x)` under `packagesDir` and return the set of frontmatter
 * violations: malformed/absent frontmatter, or a `claude-md` flag that
 * disagrees with the physical presence of the module's nested `CLAUDE.md`.
 * Empty result ⇒ the convention holds across the tree.
 */
export function checkModuleIndex(opts: { packagesDir?: string } = {}): {
  violations: ModuleIndexViolation[];
} {
  const packagesDir = opts.packagesDir ?? PACKAGES_DIR;
  const violations: ModuleIndexViolation[] = [];
  for (const indexFile of findIndexFiles(packagesDir)) {
    const rel = relative(packagesDir, indexFile);
    const parsed = parseModuleIndexFrontmatter(readFileSync(indexFile, "utf8"));
    if (!parsed.ok) {
      violations.push({ file: rel, message: parsed.reason });
      continue;
    }
    const claudeMdPath = claudeMdPathForIndex(indexFile);
    const present = existsSync(claudeMdPath) && statSync(claudeMdPath).isFile();
    const claudeMdRel = relative(packagesDir, claudeMdPath);
    if (parsed.frontmatter.claudeMd && !present) {
      violations.push({
        file: rel,
        message: `claude-md: true but ${claudeMdRel} is missing`,
      });
    } else if (!parsed.frontmatter.claudeMd && present) {
      violations.push({
        file: rel,
        message: `claude-md: false but ${claudeMdRel} exists (flip the flag or remove the file)`,
      });
    }
  }
  return { violations };
}
