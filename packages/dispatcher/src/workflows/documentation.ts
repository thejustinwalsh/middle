import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { AgentAdapter } from "@middle/core";
import { Workflow } from "bunqueue/workflow";
import type { StepContext } from "bunqueue/workflow";
import type { SessionGate } from "../hook-server.ts";
import { getRateLimitState } from "../rate-limits.ts";
import { createWorkflowRecord, updateWorkflow } from "../workflow-record.ts";
import type { CreateWorktreeOpts, WorktreeHandle } from "../worktree.ts";
import type { TmuxOps, WorktreeOps } from "./implementation.ts";

/** The worktree unit (dir + branch suffix) the docs bot claims — distinct from the recommender's. */
export const DOCS_WORKTREE_UNIT = "docs";

/** A documentation run: audit (and, when wired, maintain) one repo's docs surface. */
export type DocumentationInput = {
  /** `owner/name` — the repo whose docs surface is audited. */
  repo: string;
  /** Adapter to run the docs agent with. */
  adapter: string;
};

/** A serializable summary of the resolved `DocsTarget`, embedded in the prompt. */
export type DocsTargetSummary = {
  /** The framework name, or `markdown` for the fallback. */
  name: string;
  /** Output root for docs, relative to the repo root. */
  docsRoot: string;
  /** Whether the target supports an llms.txt surface the bot can maintain. */
  supportsLlmsTxt: boolean;
};

/** The `config` block reported to the docs agent (skill "Phase 1"). */
export type DocumentationRunConfig = {
  defaultAdapter: string;
  /**
   * Whether writing is enabled in config — the single gate for audit vs author.
   * `false` (default): the run is a read-only audit (`mode: audit`) and persists
   * nothing. `true`: the agent runs in `mode: write` — discover-or-author the docs
   * surface — and the wired `persistDocs` seam commits the result and opens a PR.
   */
  write: boolean;
};

type PrepareResult = { handle: WorktreeHandle };
type BuildPromptResult = { promptText: string };

/** Everything the documentation workflow needs that is not part of its per-run input. */
export type DocumentationDeps = {
  db: Database;
  getAdapter: (name: string) => AgentAdapter;
  sessionGate: SessionGate;
  tmux: TmuxOps;
  worktree: WorktreeOps;
  resolveRepoPath: (repo: string) => string;
  worktreeRoot: string;
  dispatcherUrl: string;
  /** The resolved docs target, injected verbatim into the prompt. */
  target: DocsTargetSummary;
  /** The `config` block reported to the docs agent. */
  config: DocumentationRunConfig;
  launchTimeoutMs?: number;
  /** Hard cap on the agent run — the spec's 5-minute ceiling. */
  agentTimeoutMs?: number;
  /**
   * The write/persist seam (commit/push/PR of generated docs). Read-only/dry-run
   * first (like the recommender's first phase): the runner leaves this UNWIRED,
   * so `persist-docs` persists nothing by construction even when `config.write`
   * is true. Wiring it is the next increment.
   */
  persistDocs?: (opts: { repo: string; worktreePath: string }) => Promise<void>;
};

const DEFAULT_LAUNCH_TIMEOUT_MS = 90_000;
const DEFAULT_AGENT_TIMEOUT_MS = 5 * 60 * 1000; // the spec's 5-minute hard cap

/**
 * Deterministic, repo-namespaced session name for the docs bot's dedicated slot.
 * Same collision-resistance reasoning as the recommender's: the readable slug is
 * lossy, so a short hash of the raw `repo` disambiguates. Exported so the
 * collision-resistance is unit-testable.
 */
export function sessionNameFor(input: DocumentationInput): string {
  const repoSlug = input.repo.replace(/[^A-Za-z0-9_-]/g, "-");
  const hash = Bun.hash(input.repo).toString(16).slice(0, 8);
  return `middle-docs-${repoSlug}-${hash}`;
}

/**
 * Assemble the documentation prompt. Reports the resolved docs target and the
 * run mode to the `documenting-the-repo` skill. `config.write` selects the mode:
 *
 * - `write: false` → **audit** (read-only/dry-run): the agent audits the docs
 *   surface against the resolved target and reports drift; it persists nothing.
 * - `write: true` → **write**: the agent discovers-or-authors — maintaining an
 *   existing surface or authoring the initial Diátaxis corpus when none exists —
 *   and writes files to disk. The dispatcher's `persistDocs` seam commits the
 *   result and opens a PR; the agent itself does not commit or push.
 *
 * Pure so it is unit-testable without the engine.
 */
export function assembleDocumentationPrompt(parts: {
  repo: string;
  target: DocsTargetSummary;
  config: DocumentationRunConfig;
}): string {
  const { repo, target, config } = parts;
  const json = (value: unknown): string => JSON.stringify(value, null, 2);
  const configBlock = `## config
\`\`\`json
${json({ default_adapter: config.defaultAdapter, write: config.write })}
\`\`\``;
  const targetBlock = `## docs_target
The resolver detected this target; route any pages and sample paths through it.
\`\`\`json
${json(target)}
\`\`\``;
  const llmsTxtLine = target.supportsLlmsTxt
    ? config.write
      ? `- maintain the llms.txt surface under \`${target.docsRoot}\`, keeping it in sync with the docs\n`
      : "- the llms.txt surface, where it has drifted from the docs\n"
    : "";

  if (config.write) {
    return `# Documentation run — docs harvester context

You are the docs harvester. Maintain this repo's documentation surface following
the \`documenting-the-repo\` skill. This is a **write** pass: write your changes to
disk. Do **not** commit, push, or open a PR — the dispatcher commits everything you
write under the docs target and opens a draft PR for human review.

- \`repo\`: ${repo}
- \`mode\`: write

${targetBlock}

${configBlock}

## what to do — discover or author
Following the skill, work the docs surface rooted at \`${target.docsRoot}\`:
- **Discover first.** If a docs surface already exists there, maintain and correct
  it: fix code samples that drift from working source, prune stale/orphaned pages,
  document public surfaces that are missing, and strip LLM-isms (the skill's blocklist).
- **Author when none exists.** If \`${target.docsRoot}\` has no surface yet, author the
  initial corpus per Diátaxis: the human-facing markdown docs (tutorial / how-to /
  reference / explanation) under \`${target.docsRoot}\`, and the agent-facing surface the
  skill prescribes (module-index frontmatter and per-folder \`CLAUDE.md\` where the skill's
  predicate holds).
- Keep code samples grounded in working source, and avoid LLM-isms.
${llmsTxtLine}`;
  }

  return `# Documentation run — docs harvester context

You are the docs harvester. Audit this repo's documentation surface following
the \`documenting-the-repo\` skill. This is a read-only/dry-run pass: report
drift, do not persist changes. The dispatcher provides everything below.

- \`repo\`: ${repo}
- \`mode\`: audit

${targetBlock}

${configBlock}

## what to audit
Following the skill's audit pass, flag and report (do not fix in this pass):
- code samples that drift from working source (the \`docs-audit\` principle)
- stale or orphaned pages under \`${target.docsRoot}\`
- public surfaces missing documentation
- LLM-isms (the skill's blocklist)
${llmsTxtLine}`;
}

/**
 * The `documentation` workflow — the recommender's sibling:
 *
 *   check-rate-limit → prepare-docs-worktree → build-prompt
 *     → spawn-docs-agent (5-min hard cap) → persist-docs → cleanup-worktree
 *
 * Linear (no park/resume — a short one-shot). Records its `workflows` row with
 * `kind:"documentation"`, so it runs on its own dedicated slot and is never
 * counted against `maxConcurrent` (same as the recommender). Read-only/dry-run
 * first: `persist-docs` is the write seam, left UNWIRED by the runner. Built as
 * a factory so the dispatcher injects real collaborators and tests inject stubs.
 */
export function createDocumentationWorkflow(deps: DocumentationDeps): Workflow<DocumentationInput> {
  const launchTimeout = deps.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  const agentTimeout = deps.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;

  /** Tear down the worktree + session. Idempotent so running it twice is safe. */
  async function teardown(ctx: StepContext<DocumentationInput>): Promise<void> {
    const prepared = ctx.steps["prepare-docs-worktree"] as PrepareResult | undefined;
    if (!prepared?.handle) return;
    await deps.tmux.killSession(sessionNameFor(ctx.input));
    await deps.worktree.destroyWorktree(prepared.handle);
  }

  async function checkRateLimit(ctx: StepContext<DocumentationInput>): Promise<void> {
    createWorkflowRecord(deps.db, {
      id: ctx.executionId,
      kind: "documentation",
      repo: ctx.input.repo,
      epicNumber: null,
      adapter: ctx.input.adapter,
    });
    const state = getRateLimitState(deps.db, ctx.input.adapter);
    const stillLimited =
      state?.status === "RATE_LIMITED" && (state.resetAt === null || state.resetAt > Date.now());
    if (stillLimited) {
      updateWorkflow(deps.db, ctx.executionId, { state: "rate-limited" });
      throw new Error(`documentation adapter ${ctx.input.adapter} is rate-limited`);
    }
  }

  async function prepareDocsWorktree(ctx: StepContext<DocumentationInput>): Promise<PrepareResult> {
    const opts: CreateWorktreeOpts = {
      repoPath: deps.resolveRepoPath(ctx.input.repo),
      repo: ctx.input.repo,
      unit: DOCS_WORKTREE_UNIT,
      worktreeRoot: deps.worktreeRoot,
    };
    const handle = await deps.worktree.createWorktree(opts);
    updateWorkflow(deps.db, ctx.executionId, { worktreePath: handle.path });
    return { handle };
  }

  /** Compensation for prepare-docs-worktree: roll the worktree back, free the session. */
  async function cleanupWorktreeCompensation(ctx: StepContext<DocumentationInput>): Promise<void> {
    await teardown(ctx);
    updateWorkflow(deps.db, ctx.executionId, { state: "compensated" });
  }

  async function buildPrompt(ctx: StepContext<DocumentationInput>): Promise<BuildPromptResult> {
    const { handle } = ctx.steps["prepare-docs-worktree"] as PrepareResult;
    const promptText = assembleDocumentationPrompt({
      repo: ctx.input.repo,
      target: deps.target,
      config: deps.config,
    });
    const middleDir = join(handle.path, ".middle");
    mkdirSync(middleDir, { recursive: true });
    writeFileSync(join(middleDir, "prompt.md"), promptText);
    return { promptText };
  }

  async function spawnDocsAgent(ctx: StepContext<DocumentationInput>): Promise<void> {
    const { handle } = ctx.steps["prepare-docs-worktree"] as PrepareResult;
    const adapter = deps.getAdapter(ctx.input.adapter);
    const sessionName = sessionNameFor(ctx.input);
    const sessionToken = crypto.randomUUID();
    const tag = `[documentation:${sessionName}]`;

    updateWorkflow(deps.db, ctx.executionId, { state: "launching", sessionName, sessionToken });
    try {
      await adapter.installHooks({
        worktree: handle.path,
        hookScriptPath: ".middle/hooks/hook.sh",
        dispatcherUrl: deps.dispatcherUrl,
        sessionName,
        sessionToken,
        // The docs bot has no Epic; reuse the field for the hook's session scope.
        epicNumber: 0,
      });
      const { argv, env } = adapter.buildLaunchCommand({
        worktree: handle.path,
        sessionName,
        sessionToken,
        envOverrides: { MIDDLE_DISPATCHER_URL: deps.dispatcherUrl },
      });
      // Clear any orphaned session of the same name before launching.
      await deps.tmux.killSession(sessionName);
      await deps.tmux.newSession({ sessionName, command: argv, cwd: handle.path, env });

      const dismissPromise = adapter.enterAutoMode({ sessionName }).catch((err: unknown) => {
        console.error(`${tag} enterAutoMode failed: ${(err as Error).message}`);
      });
      await deps.sessionGate.awaitSessionStart(sessionName, launchTimeout);
      void dismissPromise;

      updateWorkflow(deps.db, ctx.executionId, { state: "running" });
      const promptText = adapter.buildPromptText({
        promptFile: ".middle/prompt.md",
        kind: "docs",
      });
      await deps.tmux.sendText(sessionName, promptText);
      await deps.tmux.sendEnter(sessionName);

      // One-shot: drive one turn, observe the Stop. The step's own `timeout`
      // (5 min) is the hard cap; this Stop-await is bounded just under it.
      await deps.sessionGate.awaitStop(sessionName, agentTimeout);
      await deps.tmux.killSession(sessionName);
    } catch (error) {
      console.error(`${tag} spawn failed: ${(error as Error).message}`);
      await deps.tmux.killSession(sessionName);
      throw error;
    }
  }

  async function persistDocs(ctx: StepContext<DocumentationInput>): Promise<void> {
    const { handle } = ctx.steps["prepare-docs-worktree"] as PrepareResult;
    // Read-only/dry-run first: the runner leaves `persistDocs` unwired, so this
    // persists nothing regardless of `config.write`. Wiring it (commit/PR of the
    // maintained surface) is the next increment.
    if (!deps.config.write || !deps.persistDocs) return;
    await deps.persistDocs({ repo: ctx.input.repo, worktreePath: handle.path });
  }

  async function cleanupWorktree(ctx: StepContext<DocumentationInput>): Promise<void> {
    await teardown(ctx);
    updateWorkflow(deps.db, ctx.executionId, { state: "completed" });
  }

  return (
    new Workflow<DocumentationInput>("documentation")
      // retry: 1 — the check reads db state then creates the workflows row, so a
      // retry would re-run the INSERT and surface a UNIQUE violation instead of
      // the real rate-limit reason. One attempt, no retry. (Mirrors recommender.)
      .step("check-rate-limit", checkRateLimit, { retry: 1 })
      .step("prepare-docs-worktree", prepareDocsWorktree, {
        compensate: cleanupWorktreeCompensation,
      })
      .step("build-prompt", buildPrompt)
      .step("spawn-docs-agent", spawnDocsAgent, {
        retry: 1,
        timeout: launchTimeout + agentTimeout + 30_000,
      })
      .step("persist-docs", persistDocs)
      .step("cleanup-worktree", cleanupWorktree)
  );
}
