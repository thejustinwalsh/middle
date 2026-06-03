/**
 * Filesystem IO for Epic files — the read/parse and render/atomic-write helpers
 * the file-backed gateways share. Kept separate from the pure
 * `epic-file/{parser,renderer}` so those stay side-effect-free (and trivially
 * round-trip-testable); this module is the only place that touches disk.
 */

import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEpicFile } from "./epic-file/parser.ts";
import { renderEpicFile } from "./epic-file/renderer.ts";
import type { EpicFile } from "./epic-file/types.ts";

/** Absolute path of the Epic file for `slug` under `epicsDir` (`<epicsDir>/<slug>.md`). */
export function epicFilePath(epicsDir: string, slug: string): string {
  return join(epicsDir, `${slug}.md`);
}

/** Whether an Epic file exists for `slug` — the discriminator the composite gateways
 *  use to route a ref to the file path (slug → file) vs the gh backend (PR/issue number). */
export function epicFileExists(epicsDir: string, slug: string): boolean {
  return existsSync(epicFilePath(epicsDir, slug));
}

/**
 * Read + parse the Epic file for `slug`, or `null` when the file is absent. A
 * present-but-malformed file throws (via `parseEpicFile`) with a named-marker
 * error — that's a real authoring fault worth surfacing, not a missing Epic.
 */
export function readEpicFile(epicsDir: string, slug: string): EpicFile | null {
  const path = epicFilePath(epicsDir, slug);
  if (!existsSync(path)) return null;
  return parseEpicFile(readFileSync(path, "utf8"));
}

/**
 * Render `epic` and write it to `slug`'s file atomically: write a sibling
 * `.<slug>.md.tmp`, then `rename` over the target (rename is atomic within a
 * filesystem, so a concurrent reader never sees a half-written file). The temp
 * is removed on a write failure so a botched write can't strand a `.tmp`.
 */
export function writeEpicFile(epicsDir: string, slug: string, epic: EpicFile): void {
  const path = epicFilePath(epicsDir, slug);
  const tmp = join(epicsDir, `.${slug}.md.tmp`);
  try {
    writeFileSync(tmp, renderEpicFile(epic));
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** Every Epic slug in `epicsDir` (file stems of `*.md`, excluding dotfiles/`.tmp`). */
export function listEpicSlugs(epicsDir: string): string[] {
  if (!existsSync(epicsDir)) return [];
  return readdirSync(epicsDir)
    .filter((name) => name.endsWith(".md") && !name.startsWith("."))
    .map((name) => name.slice(0, -".md".length));
}
