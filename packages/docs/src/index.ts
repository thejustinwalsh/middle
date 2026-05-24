/**
 * @packageDocumentation
 * @module @middle/docs
 *
 * The docs target resolver — detects the repo's docs framework and routes
 * generated docs into its expected shape, or falls back to plain markdown.
 * Adapter-shaped, mirroring `AgentAdapter`: the harvester writes through a
 * resolved `DocsTarget` without knowing which framework it resolved to.
 *
 * Public surface:
 * - `resolveDocsTarget` — resolve a repo's `DocsTarget` (override → detect → fallback)
 * - `DocsTarget`, `DocsDetector`, `DocsTargetName`, `DocKind` — the target abstraction
 * - `detectors` — the priority-ordered framework detectors
 * - `DOCS_TARGET_NAMES` — every valid `[docs] tool` override value
 *
 * Where things live:
 * - `target.ts` — the `DocsTarget` / `DocsDetector` types
 * - `detectors/` — one detector per framework + the markdown fallback + shared util
 * - `resolve.ts` — `resolveDocsTarget` and the detector priority order
 *
 * Gotchas:
 * - Detection priority is load-bearing: a prose host (Starlight > Docusaurus >
 *   MkDocs) wins over TypeDoc, which is detected only when it stands alone.
 * - An unknown `[docs] tool` throws — a config typo is a hard error, not a
 *   silent markdown fallback.
 *
 * claude-md: false
 */
export type { DocsTarget, DocsDetector, DocsTargetName, DocKind } from "./target.ts";
export { resolveDocsTarget, detectors, DOCS_TARGET_NAMES } from "./resolve.ts";
export { markdownTarget } from "./detectors/markdown.ts";
