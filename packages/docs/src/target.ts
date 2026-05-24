/**
 * The docs target abstraction — adapter-shaped, mirroring `AgentAdapter`. A
 * `DocsDetector` recognizes a docs framework from a repo's config signals and,
 * on a match, produces a `DocsTarget` that knows where generated pages are
 * routed. The resolver picks one primary target (or the markdown fallback).
 */

/** The docs frameworks the resolver knows, plus the universal fallback. */
export type DocsTargetName = "starlight" | "docusaurus" | "mkdocs" | "typedoc" | "markdown";

/**
 * The shape of a generated page, used to route it. `guide`/`reference` are
 * authored prose (Diátaxis); `api` is generated API reference (e.g. TypeDoc
 * output). A target maps the kind to its own location convention.
 */
export type DocKind = "guide" | "reference" | "api";

/**
 * A resolved docs target: the detected (or fallback) framework and where its
 * generated docs are routed. Adapter-shaped — the harvester writes through
 * this without knowing which framework it resolved to.
 */
export type DocsTarget = {
  /** The framework name, or `markdown` for the fallback. */
  readonly name: DocsTargetName;
  /**
   * The prose docs root, relative to the repo root (POSIX separators). e.g.
   * `src/content/docs` (Starlight), `docs` (Docusaurus / MkDocs / markdown).
   */
  readonly docsRoot: string;
  /**
   * Whether this framework supports an `llms.txt` surface the harvester can
   * generate. Starlight (via `starlight-llms-txt`) and the markdown fallback do;
   * the others do not by default.
   */
  readonly supportsLlmsTxt: boolean;
  /**
   * The file path a generated page is written to, relative to the repo root
   * (POSIX separators). Defaults `kind` to `guide`.
   */
  resolveOutputPath(page: { slug: string; kind?: DocKind }): string;
};

/**
 * A detector for one framework. `detect` reads the repo's on-disk config
 * signals and returns a `DocsTarget` on a match, or `null` to defer to the
 * next detector. Pure w.r.t. the filesystem read at `repoPath` — no writes.
 */
export type DocsDetector = {
  readonly name: DocsTargetName;
  detect(repoPath: string): DocsTarget | null;
};
