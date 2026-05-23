import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { stageHookScript, stageSkills } from "./assets.ts";
import { renderRepoConfig } from "./config-template.ts";
import { addMiddleIgnore } from "./gitignore.ts";
import { writeClaudeHookSettings, writeCodexHookConfig } from "./hook-config.ts";
import { buildInitialStateIssueBody } from "./state-issue-body.ts";
import {
  BOOTSTRAP_VERSION,
  type BootstrapDeps,
  type BootstrapOptions,
  type InitResult,
  STATE_ISSUE_TITLE,
  type RepoInfo,
} from "./types.ts";

type ExistingConfig = { version: number | null; stateIssueNumber: number };

/** Read `[bootstrap] version` and `[state_issue] number` from an existing config. */
function readExistingConfig(repo: string): ExistingConfig | null {
  const path = join(repo, ".middle", "config.toml");
  if (!existsSync(path)) return null;
  try {
    const raw = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
    const bootstrap = (raw.bootstrap ?? {}) as Record<string, unknown>;
    const stateIssue = (raw.state_issue ?? {}) as Record<string, unknown>;
    const version = typeof bootstrap.version === "number" ? bootstrap.version : null;
    const number = typeof stateIssue.number === "number" ? stateIssue.number : 0;
    return { version, stateIssueNumber: number };
  } catch {
    return null;
  }
}

class BootstrapError extends Error {}

async function validateTarget(repo: string, deps: BootstrapDeps): Promise<RepoInfo> {
  if (!existsSync(join(repo, ".git"))) {
    throw new BootstrapError(`"${repo}" is not a git repository`);
  }
  if (!(await deps.isCleanWorktree(repo))) {
    throw new BootstrapError("working tree is not clean — commit or stash changes first");
  }
  if (!(await deps.getRemoteUrl(repo))) {
    throw new BootstrapError("no `origin` remote — middle needs a GitHub remote to target");
  }
  if (!(await deps.isGhAuthenticated())) {
    throw new BootstrapError("`gh` is not authenticated — run `gh auth login`");
  }
  return deps.resolveRepoInfo(repo);
}

/**
 * `mm init <repo>` — transactionally bootstrap middle into a target repo, per the
 * build spec's "Bootstrap: `mm init`". Idempotent: a re-init with a matching
 * `bootstrap.version` refreshes skills/hooks but keeps the config and existing
 * state issue; a differing version migrates. Under `--dry-run`, validates and
 * computes the plan without writing files or mutating GitHub.
 */
export async function initRepo(
  repo: string,
  deps: BootstrapDeps,
  opts: BootstrapOptions,
): Promise<InitResult> {
  const info = await validateTarget(repo, deps);
  const existing = readExistingConfig(repo);
  const mode: InitResult["mode"] =
    existing === null
      ? "fresh"
      : existing.version === BOOTSTRAP_VERSION
        ? "reinit"
        : "migrate";

  const actions: string[] = [];
  const dry = opts.dryRun;
  const note = (line: string) => actions.push(dry ? `would ${line}` : line);

  // Steps 3-4: stage skills + hook script + per-CLI hook config (every mode
  // refreshes these — that's the point of a re-init).
  note("stage skills to .claude/skills/ and .codex/skills/");
  note("stage hook script to .middle/hooks/hook.sh");
  note("write .claude/settings.json and .codex/config.toml hook config");
  let hookScriptPath = join(repo, ".middle", "hooks", "hook.sh");
  if (!dry) {
    await stageSkills(repo);
    hookScriptPath = await stageHookScript(repo);
    await writeClaudeHookSettings(repo, hookScriptPath);
    await writeCodexHookConfig(repo, hookScriptPath);
  }

  // Steps 5-6: create the label + state issue (fresh install only — a re-init
  // keeps the existing issue).
  let stateIssue = existing?.stateIssueNumber ?? 0;
  if (mode === "fresh") {
    note("create the agent-queue:state label (if absent)");
    note("create the state issue and capture its number");
    if (!dry) {
      await deps.github.ensureStateLabel(info);
      const body = buildInitialStateIssueBody(deps.now());
      stateIssue = await deps.github.createStateIssue(info, STATE_ISSUE_TITLE, body);
    }
  } else {
    note(`keep existing state issue #${stateIssue}`);
  }

  // Write config. Fresh/migrate rewrite it; a matching re-init keeps it as-is.
  if (mode !== "reinit") {
    note("write .middle/config.toml");
    if (!dry) {
      const installedAt = deps.now().toISOString();
      await mkdir(join(repo, ".middle"), { recursive: true });
      await Bun.write(
        join(repo, ".middle", "config.toml"),
        renderRepoConfig({ info, stateIssueNumber: stateIssue, installedAt }),
      );
    }
  } else {
    note("keep existing .middle/config.toml");
  }

  // Step 7: gitignore the per-repo middle dir.
  note("add .middle/ to .gitignore");
  if (!dry) await addMiddleIgnore(repo);

  return { dryRun: dry, mode, info, stateIssue, actions };
}
