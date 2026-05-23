import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const MIDDLE_IGNORE = ".middle/";

/**
 * Ensure `.middle/` is ignored in `<repo>/.gitignore` (the per-repo middle dir
 * is local-only; skills under `.claude/` stay committed). Idempotent — a no-op
 * if the line is already present. Returns true if the file was changed.
 */
export async function addMiddleIgnore(repo: string): Promise<boolean> {
  const path = join(repo, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = existing.split("\n").map((l) => l.trim());
  if (lines.includes(MIDDLE_IGNORE)) return false;
  const sep = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await Bun.write(path, `${existing}${sep}${MIDDLE_IGNORE}\n`);
  return true;
}

/**
 * Remove the `.middle/` ignore line from `<repo>/.gitignore`, leaving other
 * entries intact. Deletes the file if it empties. Returns true if changed.
 */
export async function removeMiddleIgnore(repo: string): Promise<boolean> {
  const path = join(repo, ".gitignore");
  if (!existsSync(path)) return false;
  const original = readFileSync(path, "utf8");
  const kept = original.split("\n").filter((l) => l.trim() !== MIDDLE_IGNORE);
  const rebuilt = kept.join("\n");
  if (rebuilt === original) return false;
  if (rebuilt.trim() === "") await rm(path, { force: true });
  else await Bun.write(path, rebuilt.endsWith("\n") ? rebuilt : `${rebuilt}\n`);
  return true;
}
