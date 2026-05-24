import type { DocsTarget } from "../target.ts";
import { makeTarget } from "./util.ts";

/**
 * The universal fallback: plain markdown under `docs/`. Used when no framework
 * is detected and no override forces one. Supports an `llms.txt` surface
 * (a plain `docs/llms.txt` the harvester can maintain).
 */
export function markdownTarget(docsRoot = "docs"): DocsTarget {
  return makeTarget({ name: "markdown", docsRoot, supportsLlmsTxt: true });
}
