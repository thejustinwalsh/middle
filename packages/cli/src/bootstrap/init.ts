import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { stageHookScript, stageSkills } from "./assets.ts";
import { renderLocalConfig, renderRepoPolicy } from "./config-template.ts";
import { addMiddleIgnore } from "./gitignore.ts";
import { writeClaudeHookSettings, writeCodexHookConfig } from "./hook-config.ts";
import { buildInitialStateIssueBody } from "./state-issue-body.ts";
import { writeFileStoreScaffold } from "./file-store.ts";
import {
  BOOTSTRAP_VERSION,
  type BootstrapDeps,
  type BootstrapOptions,
  type EpicStoreMode,
  type InitResult,
  STATE_ISSUE_TITLE,
  type RepoInfo,
} from "./types.ts";

type ExistingConfig = { version: number | null; stateIssueNumber: number };

class BootstrapError extends Error {}

/** Read `[bootstrap] version` and `[state_issue] number` from an existing config. */
function readExistingConfig(repo: string): ExistingConfig | null {
  const path = join(repo, ".middle", "config.toml");
  if (!existsSync(path)) return null;
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    // A present-but-unparseable config means the repo is already (at least
    // partly) bootstrapped. Treating it as a `fresh` install would create a
    // *second* state issue and clobber the existing metadata — so fail fast.
    throw new BootstrapError(
      `existing .middle/config.toml is malformed and cannot be parsed (${(error as Error).message}); fix or remove it before re-running mm init`,
    );
  }
  const bootstrap = (raw.bootstrap ?? {}) as Record<string, unknown>;
  const stateIssue = (raw.state_issue ?? {}) as Record<string, unknown>;
  const version = typeof bootstrap.version === "number" ? bootstrap.version : null;
  const number = typeof stateIssue.number === "number" ? stateIssue.number : 0;
  return { version, stateIssueNumber: number };
}

async function validateTarget(
  repo: string,
  deps: BootstrapDeps,
  epicStore: EpicStoreMode,
): Promise<RepoInfo> {
  if (!existsSync(join(repo, ".git"))) {
    throw new BootstrapError(`"${repo}" is not a git repository`);
  }
  if (!(await deps.isCleanWorktree(repo))) {
    throw new BootstrapError("working tree is not clean — commit or stash changes first");
  }
  if (!(await deps.getRemoteUrl(repo))) {
    throw new BootstrapError("no `origin` remote — middle needs a GitHub remote to target");
  }
  // File mode is offline: it makes ZERO `gh`/GitHub calls, so it skips the
  // gh-auth gate and resolves the repo identity from the local `origin` remote
  // (`resolveRepoInfoLocal`) rather than `gh repo view`.
  if (epicStore === "file") {
    return deps.resolveRepoInfoLocal(repo);
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
  const epicStore: EpicStoreMode = opts.epicStore ?? "github";
  const info = await validateTarget(repo, deps, epicStore);
  const existing = readExistingConfig(repo);
  const mode: InitResult["mode"] =
    existing === null ? "fresh" : existing.version === BOOTSTRAP_VERSION ? "reinit" : "migrate";

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

  // Steps 5-6: resolve the recommender state.
  //
  // File mode (#194): the recommender state + Epics live in local files, not a
  // GitHub issue — so this path makes ZERO `gh`/GitHub calls. Scaffold the Epic
  // directory (README + .keep), an empty state file carrying the state-issue v1
  // marker, and the per-repo `[epic_store]` config TOML; the state issue number
  // stays 0.
  let stateIssue = existing?.stateIssueNumber ?? 0;
  let needsStateIssue = false;
  if (epicStore === "file") {
    note(`scaffold .middle/${info.owner}-${info.name}.toml ([epic_store] mode=file)`);
    note("scaffold planning/epics/ (README.md + .keep)");
    note("scaffold .middle/state.md (empty recommender state, v1 marker)");
    if (!dry) {
      await writeFileStoreScaffold({ repo, info, now: deps.now() });
    }
  } else {
    // A local config number is trusted as-is. Otherwise (fresh install, or a
    // config carrying no usable number) the labeled GitHub issue is the source of
    // truth — reconcile against it before creating, so a second machine / fresh
    // clone reuses the repo's existing state issue instead of filing a duplicate.
    // config.toml only caches the number.
    needsStateIssue = stateIssue <= 0;
    if (needsStateIssue) {
      if (dry) {
        note(
          "reconcile against GitHub: reuse the existing agent-queue:state issue, else create one",
        );
      } else {
        const found = await deps.github.findStateIssues(info);
        if (found.length > 0) {
          stateIssue = found[0]!;
          note(`reuse existing state issue #${stateIssue} (found on GitHub)`);
          if (found.length > 1) {
            note(
              `WARNING: ${found.length} open state issues found (#${found.join(", #")}); ` +
                `reusing the oldest (#${stateIssue}) — close the duplicates`,
            );
          }
        } else {
          await deps.github.ensureStateLabel(info);
          const body = buildInitialStateIssueBody(deps.now());
          stateIssue = await deps.github.createStateIssue(info, STATE_ISSUE_TITLE, body);
          note("create the agent-queue:state label (if absent)");
          note("create the state issue and capture its number");
        }
      }
    } else {
      note(`keep existing state issue #${stateIssue}`);
    }
  }

  // Committed repo policy (issue #103). Written ONLY when absent — a re-init or
  // migrate must never clobber a team's committed edits (e.g. complexity_ceiling).
  // A fresh install (or one whose policy.toml was deleted) gets the spec defaults.
  const policyPath = join(repo, ".middle", "policy.toml");
  if (!existsSync(policyPath)) {
    note("write .middle/policy.toml (committed shared policy)");
    if (!dry) {
      await mkdir(join(repo, ".middle"), { recursive: true });
      await Bun.write(policyPath, renderRepoPolicy(info));
    }
  } else {
    note("keep existing .middle/policy.toml (committed policy preserved)");
  }

  // Local operational cache (gitignored, volatile). Fresh/migrate rewrite it; a
  // matching re-init keeps it as-is — unless we just minted a state issue for it,
  // whose number must be persisted.
  if (mode !== "reinit" || needsStateIssue) {
    note("write .middle/config.toml (local cache)");
    if (!dry) {
      const installedAt = deps.now().toISOString();
      await mkdir(join(repo, ".middle"), { recursive: true });
      await Bun.write(
        join(repo, ".middle", "config.toml"),
        renderLocalConfig({ stateIssueNumber: stateIssue, installedAt }),
      );
    }
  } else {
    note("keep existing .middle/config.toml");
  }

  // Step 7: gitignore the per-repo middle dir (except committed policy/gate files).
  note("add .middle/ to .gitignore");
  if (!dry) await addMiddleIgnore(repo);

  return { dryRun: dry, mode, info, epicStore, stateIssue, actions };
}
