import type { DocsDetector } from "../target.ts";
import { firstExisting, makeTarget } from "./util.ts";

const DOCUSAURUS_CONFIGS = [
  "docusaurus.config.js",
  "docusaurus.config.ts",
  "docusaurus.config.mjs",
  "docusaurus.config.cjs",
];

/**
 * Docusaurus. Detected by a `docusaurus.config.*` file — the config's presence
 * is itself the signal (unlike Astro, the config name is docs-specific). Routes
 * to the conventional `docs/` directory. No first-class `llms.txt` surface.
 */
export const docusaurusDetector: DocsDetector = {
  name: "docusaurus",
  detect(repoPath: string) {
    if (!firstExisting(repoPath, DOCUSAURUS_CONFIGS)) return null;
    return makeTarget({ name: "docusaurus", docsRoot: "docs", supportsLlmsTxt: false });
  },
};
