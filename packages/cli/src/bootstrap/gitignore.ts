import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

// The canonical ignore block (issue #103). The glob form `.middle/*` (not the
// bare directory `.middle/`) is load-bearing: git cannot re-include a file once
// a *parent directory* is excluded, so the bare form would defeat the `!`
// exceptions below. Committed files inside `.middle/` are the shared repo policy
// and the dispatcher's gate config.
const IGNORE_COMMENT =
  "# middle: local bootstrap dir, gitignored except committed policy/gate files.";
const IGNORE_BLOCK = [IGNORE_COMMENT, ".middle/*", "!.middle/policy.toml", "!.middle/verify.toml"];

// Lines this module owns — used to upgrade/clean idempotently. Includes the
// legacy bare `.middle/` so a re-init migrates an old gitignore to the glob form
// (leaving the legacy line would keep blocking the `!` exceptions).
const LEGACY_IGNORE = ".middle/";
function isMiddleLine(trimmed: string): boolean {
  return trimmed === LEGACY_IGNORE || IGNORE_BLOCK.includes(trimmed);
}

/** Strip every middle-owned line and any resulting trailing blank lines. */
function stripMiddleLines(source: string): string {
  const kept = source.split("\n").filter((l) => !isMiddleLine(l.trim()));
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
  return kept.join("\n");
}

/**
 * Ensure `<repo>/.gitignore` ignores the per-repo `.middle/` dir while keeping
 * the committed `policy.toml`/`verify.toml` tracked (the glob + `!` exceptions).
 * Idempotent, and upgrades a legacy bare-`.middle/` entry to the glob form.
 * Returns true if the file was changed.
 */
export async function addMiddleIgnore(repo: string): Promise<boolean> {
  const path = join(repo, ".gitignore");
  const original = existsSync(path) ? readFileSync(path, "utf8") : "";
  const body = stripMiddleLines(original);
  const sep = body === "" ? "" : "\n\n";
  const rebuilt = `${body}${sep}${IGNORE_BLOCK.join("\n")}\n`;
  if (rebuilt === original) return false;
  await Bun.write(path, rebuilt);
  return true;
}

/**
 * Remove middle's ignore block from `<repo>/.gitignore`, leaving other entries
 * intact (also clears a legacy bare-`.middle/` line). Deletes the file if it
 * empties. Returns true if changed.
 */
export async function removeMiddleIgnore(repo: string): Promise<boolean> {
  const path = join(repo, ".gitignore");
  if (!existsSync(path)) return false;
  const original = readFileSync(path, "utf8");
  const body = stripMiddleLines(original);
  const rebuilt = body === "" ? "" : `${body}\n`;
  if (rebuilt === original) return false;
  if (rebuilt === "") await rm(path, { force: true });
  else await Bun.write(path, rebuilt);
  return true;
}
