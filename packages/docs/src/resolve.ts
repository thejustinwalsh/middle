import type { DocsSettings } from "@middle/core";
import { docusaurusDetector } from "./detectors/docusaurus.ts";
import { markdownTarget } from "./detectors/markdown.ts";
import { mkdocsDetector } from "./detectors/mkdocs.ts";
import { starlightDetector } from "./detectors/starlight.ts";
import { typedocDetector } from "./detectors/typedoc.ts";
import { makeTarget } from "./detectors/util.ts";
import type { DocsTarget, DocsTargetName } from "./target.ts";

/**
 * Detectors in resolution priority. A prose-site host (Starlight, then
 * Docusaurus, then MkDocs) wins over TypeDoc, because TypeDoc API output
 * typically nests inside one of those (e.g. `starlight-typedoc`); TypeDoc is
 * detected only when it stands alone. Markdown is the universal fallback,
 * applied when none match — it is not in this list.
 */
export const detectors = [
  starlightDetector,
  docusaurusDetector,
  mkdocsDetector,
  typedocDetector,
] as const;

/** Every valid `tool` override value, for error messages and validation. */
export const DOCS_TARGET_NAMES: readonly DocsTargetName[] = [
  "starlight",
  "docusaurus",
  "mkdocs",
  "typedoc",
  "markdown",
];

/** Return a copy of `target` with its docs root replaced — preserves name + llms.txt support. */
function withDocsRoot(target: DocsTarget, docsRoot: string): DocsTarget {
  return makeTarget({ name: target.name, docsRoot, supportsLlmsTxt: target.supportsLlmsTxt });
}

/** Build a target forced by a `[docs] tool` override, using `path` or the framework default root. */
function forcedTarget(tool: string, pathOverride?: string): DocsTarget {
  switch (tool) {
    case "starlight":
      return makeTarget({
        name: "starlight",
        docsRoot: pathOverride ?? "src/content/docs",
        supportsLlmsTxt: true,
      });
    case "docusaurus":
      return makeTarget({
        name: "docusaurus",
        docsRoot: pathOverride ?? "docs",
        supportsLlmsTxt: false,
      });
    case "mkdocs":
      return makeTarget({
        name: "mkdocs",
        docsRoot: pathOverride ?? "docs",
        supportsLlmsTxt: false,
      });
    case "typedoc":
      return makeTarget({
        name: "typedoc",
        docsRoot: pathOverride ?? "docs",
        supportsLlmsTxt: false,
      });
    case "markdown":
      return markdownTarget(pathOverride ?? "docs");
    default:
      throw new Error(`unknown docs tool "${tool}" — valid: ${DOCS_TARGET_NAMES.join(", ")}`);
  }
}

/**
 * Resolve the docs target for a repo. Precedence:
 *
 * 1. `[docs] tool` override → that framework, with `[docs] path` (if any) as its root.
 * 2. Otherwise run {@link detectors} in priority order; the first match wins.
 *    A `[docs] path` (without `tool`) overrides the detected target's root.
 * 3. Otherwise the markdown fallback (`docs/`, or `[docs] path`).
 *
 * Throws if `tool` names an unknown framework — a config typo is a hard error,
 * not a silent fallback. Reads the repo's config files; never writes.
 */
export function resolveDocsTarget(repoPath: string, docs?: DocsSettings): DocsTarget {
  const pathOverride = docs?.path;

  if (docs?.tool) {
    return forcedTarget(docs.tool, pathOverride);
  }

  for (const detector of detectors) {
    const target = detector.detect(repoPath);
    if (target) return pathOverride ? withDocsRoot(target, pathOverride) : target;
  }

  return markdownTarget(pathOverride ?? "docs");
}
