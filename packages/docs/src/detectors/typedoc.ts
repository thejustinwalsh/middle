import type { DocsDetector } from "../target.ts";
import { firstExisting, makeTarget, readJsonIfExists, readPackageJson } from "./util.ts";

const TYPEDOC_CONFIGS = [
  "typedoc.json",
  "typedoc.config.js",
  "typedoc.config.mjs",
  "typedoc.config.cjs",
  "typedoc.config.ts",
];

/**
 * TypeDoc. Detected by a `typedoc.json` / `typedoc.config.*` file or a
 * `typedoc` key in package.json. Routes to TypeDoc's `out` directory (read
 * from `typedoc.json` when present; default `docs`) — this target is API
 * reference output, so its `kind` is conceptually `api`. No `llms.txt`.
 *
 * Lowest priority among real frameworks: TypeDoc typically nests *inside* a
 * prose host (e.g. `starlight-typedoc`), so a co-resident Starlight/Docusaurus
 * wins and TypeDoc is detected only when it stands alone.
 */
export const typedocDetector: DocsDetector = {
  name: "typedoc",
  detect(repoPath: string) {
    const configName = firstExisting(repoPath, TYPEDOC_CONFIGS);
    const pkg = readPackageJson(repoPath);
    const inPkg = pkg !== null && typeof pkg.typedoc === "object" && pkg.typedoc !== null;
    if (!configName && !inPkg) return null;

    // Prefer an explicit `out` from typedoc.json; package.json `typedoc.out`
    // is the fallback signal source.
    let out = "docs";
    const json = readJsonIfExists(repoPath, "typedoc.json");
    if (json && typeof json.out === "string") {
      out = json.out;
    } else if (inPkg) {
      const td = pkg!.typedoc as Record<string, unknown>;
      if (typeof td.out === "string") out = td.out;
    }
    return makeTarget({ name: "typedoc", docsRoot: out, supportsLlmsTxt: false });
  },
};
