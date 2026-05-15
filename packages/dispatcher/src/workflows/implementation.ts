import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { AgentAdapter, StopClassification } from "@middle/core";
import { Workflow } from "bunqueue/workflow";
import type { StepContext } from "bunqueue/workflow";
import type { SessionGate } from "../hook-server.ts";
import type { CreateWorktreeOpts, WorktreeHandle } from "../worktree.ts";
import {
  createWorkflowRecord,
  updateWorkflow,
  type WorkflowState,
} from "../workflow-record.ts";

/** A dispatch unit: an Epic (or standalone issue) pointed at one adapter. */
export type ImplementationInput = {
  repo: string;
  epicNumber: number;
  adapter: string;
};

/** The tmux surface the workflow drives — structural so tests can stub it. */
export type TmuxOps = {
  newSession(opts: {
    sessionName: string;
    command: string[];
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<void>;
  sendText(sessionName: string, text: string): Promise<void>;
  sendEnter(sessionName: string): Promise<void>;
  killSession(sessionName: string): Promise<void>;
};

/** The worktree surface the workflow drives — structural so tests can stub it. */
export type WorktreeOps = {
  createWorktree(opts: CreateWorktreeOpts): Promise<WorktreeHandle>;
  destroyWorktree(handle: WorktreeHandle): Promise<void>;
};

/** Everything the workflow needs that is not part of its per-run input. */
export type ImplementationDeps = {
  db: Database;
  getAdapter: (name: string) => AgentAdapter;
  sessionGate: SessionGate;
  tmux: TmuxOps;
  worktree: WorktreeOps;
  resolveRepoPath: (repo: string) => string;
  worktreeRoot: string;
  dispatcherUrl: string;
  launchTimeoutMs?: number;
  stopTimeoutMs?: number;
};

const DEFAULT_LAUNCH_TIMEOUT_MS = 90_000;
const DEFAULT_STOP_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/** Session names are deterministic so compensations can recompute them. */
function sessionNameFor(input: ImplementationInput): string {
  return `middle-${input.epicNumber}`;
}

function finalStateFor(classification: StopClassification): WorkflowState {
  switch (classification.kind) {
    case "done":
      return "completed";
    case "failed":
      return "failed";
    case "rate-limited":
      return "rate-limited";
    case "asked-question":
      return "waiting-human";
    case "bare-stop":
      // the minimal 3-step workflow has no nudge loop — a clean stop is terminal here
      return "completed";
  }
}

type PrepareResult = { handle: WorktreeHandle };
type DriveResult = { classification: StopClassification; sessionName: string };

/**
 * The Phase 1 `implementation` workflow — deliberately just three steps:
 * prepare-worktree → launch-and-drive → cleanup. No skill enforcement, no
 * sub-issue plan resolution, no hook-driven heartbeats; those land in Phases
 * 2 and 4. `launch-and-drive` runs the launch → drive → observe loop and reacts
 * to the `Stop` boundary via the adapter's `classifyStop`.
 *
 * Built as a factory so the dispatcher injects real collaborators and tests
 * inject stubs. The workflow's `executionId` doubles as the `workflows.id`.
 */
export function createImplementationWorkflow(
  deps: ImplementationDeps,
): Workflow<ImplementationInput> {
  const launchTimeout = deps.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  const stopTimeout = deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

  async function prepareWorktree(ctx: StepContext<ImplementationInput>): Promise<PrepareResult> {
    createWorkflowRecord(deps.db, {
      id: ctx.executionId,
      kind: "implementation",
      repo: ctx.input.repo,
      epicNumber: ctx.input.epicNumber,
      adapter: ctx.input.adapter,
    });
    const handle = await deps.worktree.createWorktree({
      repoPath: deps.resolveRepoPath(ctx.input.repo),
      repo: ctx.input.repo,
      issueNumber: ctx.input.epicNumber,
      worktreeRoot: deps.worktreeRoot,
    });
    updateWorkflow(deps.db, ctx.executionId, { worktreePath: handle.path });
    return { handle };
  }

  /** Compensation for prepare-worktree: roll the worktree back, free the session. */
  async function cleanupWorktree(ctx: StepContext<ImplementationInput>): Promise<void> {
    const prepared = ctx.steps["prepare-worktree"] as PrepareResult | undefined;
    if (prepared?.handle) {
      await deps.tmux.killSession(sessionNameFor(ctx.input));
      await deps.worktree.destroyWorktree(prepared.handle);
    }
    updateWorkflow(deps.db, ctx.executionId, { state: "compensated" });
  }

  async function launchAndDrive(ctx: StepContext<ImplementationInput>): Promise<DriveResult> {
    const { handle } = ctx.steps["prepare-worktree"] as PrepareResult;
    const adapter = deps.getAdapter(ctx.input.adapter);
    const sessionName = sessionNameFor(ctx.input);
    const sessionToken = crypto.randomUUID();
    const tag = `[workflow:${sessionName}]`;

    updateWorkflow(deps.db, ctx.executionId, { state: "launching", sessionName, sessionToken });

    try {
      console.error(`${tag} installing hooks in ${handle.path}`);
      await adapter.installHooks({
        worktree: handle.path,
        hookScriptPath: ".middle/hooks/hook.sh",
        dispatcherUrl: deps.dispatcherUrl,
        sessionName,
        sessionToken,
        epicNumber: ctx.input.epicNumber,
      });

      const { argv, env } = adapter.buildLaunchCommand({
        worktree: handle.path,
        sessionName,
        sessionToken,
        envOverrides: {
          MIDDLE_DISPATCHER_URL: deps.dispatcherUrl,
          MIDDLE_EPIC: String(ctx.input.epicNumber),
        },
      });
      console.error(`${tag} launching tmux session: ${argv.join(" ")} (cwd=${handle.path})`);
      await deps.tmux.newSession({ sessionName, command: argv, cwd: handle.path, env });

      // drive: SessionStart yields session_id + transcript_path, then auto mode + prompt
      console.error(`${tag} waiting for SessionStart hook (timeout ${launchTimeout}ms)`);
      const startPayload = await deps.sessionGate.awaitSessionStart(sessionName, launchTimeout);
      console.error(
        `${tag} SessionStart received — session_id=${startPayload.session_id ?? "<missing>"}`,
      );
      const transcriptPath = adapter.resolveTranscriptPath(startPayload);
      updateWorkflow(deps.db, ctx.executionId, {
        state: "running",
        sessionId:
          typeof startPayload.session_id === "string" ? startPayload.session_id : undefined,
        transcriptPath,
      });

      console.error(`${tag} entering auto mode`);
      await adapter.enterAutoMode({ sessionName });
      const promptText = adapter.buildPromptText({
        promptFile: ".middle/prompt.md",
        kind: "initial",
      });
      console.error(`${tag} sending prompt: "${promptText}"`);
      await deps.tmux.sendText(sessionName, promptText);
      await deps.tmux.sendEnter(sessionName);

      // observe: the Stop boundary is the signal — not a process exit
      console.error(`${tag} waiting for Stop hook (timeout ${stopTimeout}ms)`);
      const stopPayload = await deps.sessionGate.awaitStop(sessionName, stopTimeout);
      const sentinelPresent = existsSync(join(handle.path, ".middle", "blocked.json"));
      const classification = adapter.classifyStop({
        payload: stopPayload,
        transcriptPath,
        sentinelPresent,
        worktree: handle.path,
      });
      console.error(`${tag} Stop received — classification=${classification.kind}`);
      return { classification, sessionName };
    } catch (error) {
      // never leak a tmux session on the failure path; the compensation rolls
      // back the worktree
      console.error(`${tag} step failed: ${(error as Error).message}`);
      await deps.tmux.killSession(sessionName);
      throw error;
    }
  }

  async function cleanup(ctx: StepContext<ImplementationInput>): Promise<void> {
    const { handle } = ctx.steps["prepare-worktree"] as PrepareResult;
    const { classification, sessionName } = ctx.steps["launch-and-drive"] as DriveResult;
    await deps.tmux.killSession(sessionName);
    await deps.worktree.destroyWorktree(handle);
    updateWorkflow(deps.db, ctx.executionId, { state: finalStateFor(classification) });
  }

  return new Workflow<ImplementationInput>("implementation")
    .step("prepare-worktree", prepareWorktree, { compensate: cleanupWorktree })
    // retry: 1 — bunqueue's `retry` is `maxAttempts` (loop runs `attempt = 1
    // … <= retry`), not "retries after the first attempt". `1` means exactly
    // one attempt, no retries. Phase 1 fails fast and compensates: retrying a
    // launch piles up tmux/branch state and aggravates bunqueue's
    // job-lifecycle race on the failure path. The full workflow's retry
    // budgets (spec) live on `plan` / `implement-loop`.
    .step("launch-and-drive", launchAndDrive, { retry: 1 })
    .step("cleanup", cleanup);
}
