import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DocKind, DocsTarget, DocsTargetName } from "../target.ts";

/** Return the first of `names` that exists under `repoPath`, else null. */
export function firstExisting(repoPath: string, names: string[]): string | null {
  for (const name of names) {
    if (existsSync(join(repoPath, name))) return name;
  }
  return null;
}

/** Read a repo-relative file as UTF-8, or null if it does not exist / can't be read. */
export function readIfExists(repoPath: string, name: string): string | null {
  const path = join(repoPath, name);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Read + JSON-parse a repo-relative file, or null on absence / parse error. */
export function readJsonIfExists(repoPath: string, name: string): Record<string, unknown> | null {
  const raw = readIfExists(repoPath, name);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Parse `<repoPath>/package.json`, or null if missing / malformed. */
export function readPackageJson(repoPath: string): Record<string, unknown> | null {
  return readJsonIfExists(repoPath, "package.json");
}

/** True if `name` appears in package.json `dependencies` or `devDependencies`. */
export function hasDependency(pkg: Record<string, unknown> | null, predicate: (dep: string) => boolean): boolean {
  if (!pkg) return false;
  for (const field of ["dependencies", "devDependencies"] as const) {
    const deps = pkg[field];
    if (typeof deps === "object" && deps !== null) {
      if (Object.keys(deps as Record<string, unknown>).some(predicate)) return true;
    }
  }
  return false;
}

/**
 * Build a `DocsTarget` with a uniform `resolveOutputPath`: `<docsRoot>/<slug><ext>`,
 * with POSIX separators (docs paths are repo-relative URLs, not OS paths). The
 * slug's own slashes are preserved so nested pages route into subfolders.
 */
export function makeTarget(opts: {
  name: DocsTargetName;
  docsRoot: string;
  supportsLlmsTxt: boolean;
  ext?: string;
}): DocsTarget {
  const ext = opts.ext ?? ".md";
  const docsRoot = normalizeRoot(opts.docsRoot);
  return {
    name: opts.name,
    docsRoot,
    supportsLlmsTxt: opts.supportsLlmsTxt,
    resolveOutputPath(page: { slug: string; kind?: DocKind }): string {
      const slug = page.slug.replace(/^\/+/, "").replace(/\.mdx?$/, "");
      return `${docsRoot}/${slug}${ext}`;
    },
  };
}

/** Strip leading `./` and trailing slashes, normalize to POSIX separators. */
export function normalizeRoot(root: string): string {
  return root.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}
