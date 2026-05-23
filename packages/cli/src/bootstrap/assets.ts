import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HOOK_SH } from "@middle/core";
import { BOOTSTRAP_SKILLS_DIR } from "./skills-sync.ts";

/** Skill directories that `mm init` stamps (the immediate subdirs of the mirror). */
export function listBootstrapSkills(): string[] {
  if (!existsSync(BOOTSTRAP_SKILLS_DIR)) return [];
  return readdirSync(BOOTSTRAP_SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/** Recursively copy a directory tree, preserving file bytes. */
export async function copyDir(src: string, dst: string): Promise<void> {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      await copyDir(from, to);
    } else if (entry.isFile()) {
      await mkdir(dirname(to), { recursive: true });
      await writeFile(to, await readFile(from));
    }
  }
}

/**
 * Copy each canonical skill into `<repo>/.claude/skills/<skill>/` and mirror it
 * to `<repo>/.codex/skills/<skill>/` (Codex doesn't read `.claude/`). Skills are
 * committed in the target repo (shared with collaborators).
 */
export async function stageSkills(repo: string): Promise<string[]> {
  const staged: string[] = [];
  for (const skill of listBootstrapSkills()) {
    const src = join(BOOTSTRAP_SKILLS_DIR, skill);
    for (const cliDir of [".claude", ".codex"]) {
      const dst = join(repo, cliDir, "skills", skill);
      await mkdir(dst, { recursive: true });
      await copyDir(src, dst);
      staged.push(join(cliDir, "skills", skill));
    }
  }
  return staged;
}

/** Write the universal hook script to `<repo>/.middle/hooks/hook.sh` (chmod +x). */
export async function stageHookScript(repo: string): Promise<string> {
  const rel = join(".middle", "hooks", "hook.sh");
  const path = join(repo, rel);
  await mkdir(join(repo, ".middle", "hooks"), { recursive: true });
  await Bun.write(path, HOOK_SH);
  await chmod(path, 0o755);
  return path;
}
