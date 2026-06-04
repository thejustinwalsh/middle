/**
 * Docs cross-link guard (#215): keeps `docs/dogfooding.md` honest against the
 * real CLI. Every `mm <command>` the dogfooding guide names must resolve to a
 * command registered in `packages/cli/src/index.ts`, and `mm verify-file-mode
 * --help` (the command the new "Live-smoke verification" section documents) must
 * boot and exit 0 — so a renamed or dropped command can't leave the guide citing
 * a command that no longer exists.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const CLI = join(import.meta.dir, "..", "src", "index.ts");
const DOGFOODING = join(REPO_ROOT, "docs", "dogfooding.md");

/**
 * Commands registered via `.command("name")` in the CLI entry. Captures up to the
 * first space or quote so an inline-arg form (`.command("name <arg>")`) still
 * resolves to `name`.
 */
function registeredCommands(): Set<string> {
  const src = readFileSync(CLI, "utf8");
  const out = new Set<string>();
  for (const m of src.matchAll(/\.command\("([a-z][a-z-]*)/g)) out.add(m[1]!);
  return out;
}

/**
 * `mm <command>` tokens a doc *runs* — only where `mm ` starts a line (a fenced
 * command) or follows an inline-code backtick. Prose like "mm then dispatches"
 * is deliberately not matched, so an English sentence can't trip the guard.
 */
function mentionedCommands(docPath: string): string[] {
  const text = readFileSync(docPath, "utf8");
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|`)\s*mm ([a-z][a-z-]*[a-z])\b/gm)) out.add(m[1]!);
  return [...out];
}

describe("docs/dogfooding.md cross-links", () => {
  test("every `mm <command>` mentioned resolves to a registered command", () => {
    const registered = registeredCommands();
    expect(registered.has("verify-file-mode")).toBe(true); // guards the parser itself
    const mentioned = mentionedCommands(DOGFOODING);
    expect(mentioned.length).toBeGreaterThan(0);
    const unknown = mentioned.filter((c) => !registered.has(c));
    expect(unknown).toEqual([]);
    // The section the guide adds names verify-file-mode by exact string.
    expect(readFileSync(DOGFOODING, "utf8")).toContain("mm verify-file-mode");
  });

  test("mm verify-file-mode --help boots and exits 0", async () => {
    const proc = Bun.spawn(["bun", CLI, "verify-file-mode", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain("verify-file-mode");
  });
});
