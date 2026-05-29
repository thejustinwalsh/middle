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

/** Parse a TOML file into a table, tolerating absence and malformed content. */
function tryParseToml(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const raw = parseToml(readFileSync(path, "utf8"));
    return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readRepoInfo(table: unknown): RepoInfo | null {
  const t = (table ?? {}) as Record<string, unknown>;
  if (typeof t.owner !== "string" || typeof t.name !== "string") return null;
  // Guard each field: malformed policy (a number, a table, etc.) must never
  // leak a non-string into RepoInfo. owner/name being non-string disqualifies
  // the block entirely; a bad default_branch just falls back to "main".
  const defaultBranch = typeof t.default_branch === "string" ? t.default_branch : "main";
  return { owner: t.owner, name: t.name, defaultBranch };
}

/**
 * Read the state-issue number and repo identity from the per-repo files. Post-#103
 * the `[repo]` block lives in the committed `policy.toml` while the `[state_issue]`
 * number lives in the gitignored `config.toml` cache — but tolerate a legacy
 * single-file install that still carries either in `config.toml`. Reading the
 * identity locally (not just from the remote) is what lets `mm uninit` close the
 * state issue offline / after `origin` is gone, the guarantee the split must keep.
 */
function readConfig(repo: string): ParsedConfig {
  const cache = tryParseToml(join(repo, ".middle", "config.toml"));
  const policy = tryParseToml(join(repo, ".middle", "policy.toml"));
  const stateTbl = (cache.state_issue ?? policy.state_issue ?? {}) as Record<string, unknown>;
  const number = typeof stateTbl.number === "number" ? stateTbl.number : 0;
  // [repo] now lives in policy.toml; fall back to the cache for legacy installs.
  const info = readRepoInfo(policy.repo) ?? readRepoInfo(cache.repo);
  return { stateIssue: number, info };
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
