import type { DocsDetector } from "../target.ts";
import { firstExisting, hasDependency, makeTarget, readIfExists, readPackageJson } from "./util.ts";

const ASTRO_CONFIGS = [
  "astro.config.mjs",
  "astro.config.ts",
  "astro.config.js",
  "astro.config.mts",
  "astro.config.cjs",
];

/** `@astrojs/starlight` or any `starlight-*` plugin (e.g. `starlight-typedoc`). */
const STARLIGHT_RE = /@astrojs\/starlight|starlight-[\w-]+/;

/**
 * Astro Starlight. Detected by an `astro.config.*` file *and* a Starlight
 * signal — either the config imports `@astrojs/starlight` / a `starlight-*`
 * plugin, or package.json depends on one. The bare astro config alone is not
 * enough: a non-docs Astro site is not a docs target.
 *
 * Routes to Starlight's content collection (`src/content/docs`) and supports an
 * `llms.txt` surface (via `starlight-llms-txt`).
 */
export const starlightDetector: DocsDetector = {
  name: "starlight",
  detect(repoPath: string) {
    const configName = firstExisting(repoPath, ASTRO_CONFIGS);
    if (!configName) return null;
    const config = readIfExists(repoPath, configName) ?? "";
    const pkg = readPackageJson(repoPath);
    const signalled = STARLIGHT_RE.test(config) || hasDependency(pkg, (d) => STARLIGHT_RE.test(d));
    if (!signalled) return null;
    return makeTarget({ name: "starlight", docsRoot: "src/content/docs", supportsLlmsTxt: true });
  },
};
