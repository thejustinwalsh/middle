import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { listBootstrapSkills } from "./assets.ts";
import { removeMiddleIgnore } from "./gitignore.ts";
import { stripClaudeHookSettings, stripCodexHookConfig } from "./hook-config.ts";
import {
  type BootstrapDeps,
  type BootstrapOptions,
  type RepoInfo,
  type UninitResult,
} from "./types.ts";

type ParsedConfig = { stateIssue: number; info: RepoInfo | null };

function readConfig(repo: string): ParsedConfig {
  const path = join(repo, ".middle", "config.toml");
  if (!existsSync(path)) return { stateIssue: 0, info: null };
  try {
    const raw = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
    const stateIssue = (raw.state_issue ?? {}) as Record<string, unknown>;
    const repoTbl = (raw.repo ?? {}) as Record<string, unknown>;
    const number = typeof stateIssue.number === "number" ? stateIssue.number : 0;
    const info =
      typeof repoTbl.owner === "string" && typeof repoTbl.name === "string"
        ? {
            owner: repoTbl.owner,
            name: repoTbl.name,
            defaultBranch: (repoTbl.default_branch as string) ?? "main",
          }
        : null;
    return { stateIssue: number, info };
  } catch {
    return { stateIssue: 0, info: null };
  }
}

/**
 * `mm uninit <repo>` — reverse `mm init`, per the build spec. Closes the state
 * issue, removes the bootstrapped skill dirs / `.middle/`, strips only middle's
 * hook-config blocks (leaving other entries intact), and removes `.middle/` from
 * `.gitignore`. Under `--dry-run`, reports the plan without changing anything.
 *
 * The `agent-queue:state` label is intentionally preserved (per the spec, that's
 * fine — deleting it is optional and destructive).
 */
export async function uninitRepo(
  repo: string,
  deps: BootstrapDeps,
  opts: BootstrapOptions,
): Promise<UninitResult> {
  const { stateIssue, info } = readConfig(repo);
  const actions: string[] = [];
  const dry = opts.dryRun;
  const note = (line: string) => actions.push(dry ? `would ${line}` : line);

  if (stateIssue > 0) {
    // The config may carry a state-issue number but no (valid) [repo] block;
    // fall back to resolving the repo identity from its remote so we never leave
    // the GitHub issue orphaned open.
    const target = info ?? (await deps.resolveRepoInfo(repo).catch(() => null));
    if (target) {
      note(`close state issue #${stateIssue}`);
      if (!dry) await deps.github.closeStateIssue(target, stateIssue, "Removed via `mm uninit`.");
    } else {
      note(
        `state issue #${stateIssue}: could not resolve repo identity — left open, close it manually`,
      );
    }
  }

  const hookScriptPath = join(repo, ".middle", "hooks", "hook.sh");
  note("strip middle hook config from .claude/settings.json and .codex/config.toml");
  if (!dry) {
    await stripClaudeHookSettings(repo, hookScriptPath);
    await stripCodexHookConfig(repo);
  }

  for (const skill of listBootstrapSkills()) {
    for (const cliDir of [".claude", ".codex"]) {
      const dir = join(repo, cliDir, "skills", skill);
      if (existsSync(dir)) {
        note(`remove ${join(cliDir, "skills", skill)}`);
        if (!dry) await rm(dir, { recursive: true, force: true });
      }
    }
  }

  if (existsSync(join(repo, ".middle"))) {
    note("remove .middle/");
    if (!dry) await rm(join(repo, ".middle"), { recursive: true, force: true });
  }

  note("remove .middle/ from .gitignore");
  if (!dry) await removeMiddleIgnore(repo);

  return { dryRun: dry, stateIssue, actions };
}
