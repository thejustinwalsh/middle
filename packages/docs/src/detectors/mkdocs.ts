import type { DocsDetector } from "../target.ts";
import { firstExisting, makeTarget, readIfExists } from "./util.ts";

const MKDOCS_CONFIGS = ["mkdocs.yml", "mkdocs.yaml"];

/** Read `docs_dir:` from an mkdocs config, stripping quotes. Default `docs`. */
function docsDirFrom(config: string): string {
  // MkDocs `docs_dir` is a top-level scalar; a line-anchored read avoids pulling
  // in a YAML parser for one key. Matches `docs_dir: site_docs` / `docs_dir: "x"`.
  const match = /^docs_dir:\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/m.exec(config);
  return match ? match[1]!.trim() : "docs";
}

/**
 * MkDocs. Detected by `mkdocs.yml` / `mkdocs.yaml`. Routes to the config's
 * `docs_dir` (default `docs`). The nav in `mkdocs.yml` is the framework's
 * concern — the harvester writes pages under `docs_dir`; keeping the nav in
 * sync is left to the authoring skill. No `llms.txt` surface.
 */
export const mkdocsDetector: DocsDetector = {
  name: "mkdocs",
  detect(repoPath: string) {
    const configName = firstExisting(repoPath, MKDOCS_CONFIGS);
    if (!configName) return null;
    const config = readIfExists(repoPath, configName) ?? "";
    return makeTarget({ name: "mkdocs", docsRoot: docsDirFrom(config), supportsLlmsTxt: false });
  },
};
