/**
 * PATH/shell-rc reasoning for the `mm doctor` bun-path check.
 *
 * The root cause this module addresses: Bun's global bin dir
 * (`bun pm bin -g` → `~/.bun/bin`, where `bun link` drops the `mm` symlink) is
 * not on `$PATH` under a Homebrew Bun install. The pure functions below let
 * `doctor.ts` detect that and write the canonical export into the right rc file.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Strip a single trailing slash so `/x/` and `/x` compare equal. */
function normalizeDir(dir: string): string {
  return dir.endsWith("/") && dir.length > 1 ? dir.slice(0, -1) : dir;
}

/** True iff `dir` appears (trailing-slash-insensitively) in a `:`-joined PATH. */
export function isDirOnPath(dir: string, pathEnv: string): boolean {
  const target = normalizeDir(dir);
  return pathEnv
    .split(":")
    .filter((entry) => entry.length > 0)
    .some((entry) => normalizeDir(entry) === target);
}

/**
 * Bun's global bin dir — `bun pm bin -g` if it succeeds, else `~/.bun/bin`.
 * The fallback matches Bun's default and is what Homebrew installs leave behind.
 */
export async function getBunGlobalBinDir(): Promise<string> {
  const fallback = join(homedir(), ".bun", "bin");
  const bun = Bun.which("bun");
  if (!bun) return fallback;
  try {
    const proc = Bun.spawn(["bun", "pm", "bin", "-g"], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) === 0 && out.length > 0) return out;
  } catch {
    // fall through to the default
  }
  return fallback;
}

/** Where to add the PATH export, resolved from `$SHELL`. */
export type ShellRc = { shell: "zsh" | "bash"; rcPath: string } | { unknown: true };

/** zsh → `~/.zshrc`, bash → `~/.bashrc`, anything else → `{ unknown: true }`. */
export function resolveShellRc(shell: string | undefined, home: string): ShellRc {
  if (!shell) return { unknown: true };
  if (shell.endsWith("zsh")) return { shell: "zsh", rcPath: join(home, ".zshrc") };
  if (shell.endsWith("bash")) return { shell: "bash", rcPath: join(home, ".bashrc") };
  return { unknown: true };
}

/**
 * The shell block to append. Emits the canonical Bun-installer form when
 * `binDir` is the default `~/.bun/bin`, else a literal single-line PATH export.
 */
export function bunPathSnippet(binDir: string, home: string): string {
  const canonical = join(home, ".bun", "bin");
  if (normalizeDir(binDir) === normalizeDir(canonical)) {
    return '# bun\nexport BUN_INSTALL="$HOME/.bun"\nexport PATH="$BUN_INSTALL/bin:$PATH"';
  }
  return `# bun\nexport PATH="${binDir}:$PATH"`;
}

/** True if the rc already wires `binDir` onto PATH (idempotency guard). */
export function rcAlreadyConfigured(rcContents: string, binDir: string): boolean {
  return rcContents.includes(binDir) || rcContents.includes("$BUN_INSTALL/bin");
}

/**
 * Append `snippet` to the rc at `rcPath` unless `binDir` is already wired on
 * PATH there. Reads the file (treats a missing file as empty), so the write is
 * idempotent across repeated `mm doctor --fix` runs.
 */
export function applyPathFix(args: { rcPath: string; snippet: string; binDir: string }): {
  changed: boolean;
} {
  const existing = existsSync(args.rcPath) ? readFileSync(args.rcPath, "utf8") : "";
  if (rcAlreadyConfigured(existing, args.binDir)) return { changed: false };
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(args.rcPath, `${prefix}\n${args.snippet}\n`);
  return { changed: true };
}
