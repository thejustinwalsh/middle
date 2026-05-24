import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { AgentAdapter, StopClassification } from "@middle/core";
import { Workflow } from "bunqueue/workflow";
import type { StepContext } from "bunqueue/workflow";
import { type PlanCommentReader, verifyPlanComment } from "../gates/plan-comment.ts";
import type { SessionGate } from "../hook-server.ts";
import { markAvailableOnSuccess, parseResetAt, setRateLimited } from "../rate-limits.ts";
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
  /**
   * Positive done-signal (skill enforcement #80): the only thing that turns a
   * `bare-stop` into completion is a ready, non-draft Epic PR. When this seam is
   * wired, a `bare-stop` without that signal nudges the agent (bounded) instead
   * of finalizing as `completed`. Left optional so callers that haven't opted in
   * keep the legacy "bare-stop → completed" behavior.
   */
  epicPrReadiness?: (repo: string, epicNumber: number) => Promise<{ exists: boolean; isDraft: boolean }>;
  /** Max "continue" nudges on a bare-stop before parking in waiting-human. */
  maxNudges?: number;
  /** Per-nudge Stop-await timeout. */
  nudgeStopTimeoutMs?: number;
  /**
   * Plan-comment guard (skill enforcement #1): when wired, a `done` dispatch only
   * truly completes if a comment on the Epic carries the plan body. Left optional
   * so the gate-free unit tests (and any caller that hasn't opted in) keep their
   * unguarded completion behavior.
   */
  planCommentReader?: PlanCommentReader;
  /** The agent's gh account — restricts the plan-comment match to its comments. */
  agentLogin?: string;
};

const DEFAULT_LAUNCH_TIMEOUT_MS = 90_000;
const DEFAULT_STOP_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const DEFAULT_MAX_NUDGES = 3;
const DEFAULT_NUDGE_STOP_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Session names are deterministic so compensations can recompute them, and
 * namespaced by repo so concurrent dispatches of the same issue number across
 * different repos don't collide on one tmux session (which would make the
 * second dispatch's failure-path `killSession` tear down the first's live
 * session). Matches the repo-namespaced worktree path layout.
 */
function sessionNameFor(input: ImplementationInput): string {
  const repoSlug = input.repo.replace(/[^A-Za-z0-9_-]/g, "-");
  return `middle-${repoSlug}-${input.epicNumber}`;
}

/**
 * Write the default dispatch brief to `.middle/prompt.md` if one isn't already
 * present. The skill (invoked by the slash command) reads this file as its
 * operating brief — framing, not "use the skill" (the slash command already
 * did that). An operator-supplied brief (committed in the repo, or written by a
 * future `mm dispatch --note` / the recommender) is left untouched.
 */
function ensurePromptFile(worktreePath: string, epicNumber: number): void {
  const middleDir = join(worktreePath, ".middle");
  const promptPath = join(middleDir, "prompt.md");
  if (existsSync(promptPath)) return;
  mkdirSync(middleDir, { recursive: true });
  writeFileSync(
    promptPath,
    `# middle dispatch brief — Epic #${epicNumber}

You are running autonomously under middle. There is no human watching in real
time. Operating rules for this dispatch:

- Work through every phase continuously. The mechanical verification gates are
  the gates between phases — do not pause for confirmation between them.
- Do not stop to ask questions you can resolve yourself. Pause only if you are
  genuinely blocked: ambiguous acceptance criteria, or a decision needing more
  candidate forks than the complexity ceiling.
- The terminal state is: every phase verified, the PR marked ready for review,
  and the reviewer's brief posted on both the Epic and the PR. Then stop.

## Operator notes for this dispatch
(none)
`,
  );
}

/**
 * Read the workstream's committed plan from the worktree. The implementer skill
 * writes it to `planning/issues/<epic>/plan.md` and posts the same body as the
 * Epic comment the plan-comment guard checks for. A missing file yields "" — the
 * guard treats that as "no plan", which is the correct outcome.
 */
function readPlanBody(worktreePath: string, epicNumber: number): string {
  try {
    return readFileSync(join(worktreePath, "planning", "issues", String(epicNumber), "plan.md"), "utf8");
  } catch {
    return "";
  }
}

/**
 * The drive loop's resolved outcome. It is a `StopClassification` plus one
 * dispatcher-only terminal: `nudge-exhausted`, when a `bare-stop` never produced
 * a positive done-signal within the nudge budget. Keeping this out of the core
 * `StopClassification` union keeps the adapter's per-Stop classifier honest — a
 * single Stop is never "nudge-exhausted"; only the loop is.
 */
type DriveOutcome = StopClassification | { kind: "nudge-exhausted" };

function finalStateForOutcome(outcome: DriveOutcome): WorkflowState {
  switch (outcome.kind) {
    case "done":
      return "completed";
    case "failed":
      return "failed";
    case "rate-limited":
      return "rate-limited";
    case "asked-question":
      return "waiting-human";
    case "nudge-exhausted":
      // bounded nudges produced no positive done-signal — park for a human
      return "waiting-human";
    case "bare-stop":
      // legacy path: no positive-done-signal seam wired, so a clean stop completes
      return "completed";
  }
}

type PrepareResult = { handle: WorktreeHandle };
type DriveResult = { outcome: DriveOutcome; sessionName: string };

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

  const maxNudges = deps.maxNudges ?? DEFAULT_MAX_NUDGES;
  const nudgeStopTimeout = deps.nudgeStopTimeoutMs ?? DEFAULT_NUDGE_STOP_TIMEOUT_MS;

  /**
   * Resolve a `bare-stop` into a terminal outcome. Completion requires a
   * positive done-signal — a ready, non-draft Epic PR. Without it, send a cheap
   * same-session "continue" nudge and re-await the Stop, up to `maxNudges`; a
   * nudge that produces a definitive classification (done, question, failure,
   * rate-limit) short-circuits. Exhausting the budget parks in waiting-human
   * rather than silently completing.
   */
  async function resolveBareStop(args: {
    tag: string;
    sessionName: string;
    repo: string;
    epicNumber: number;
    classifyAt: (payload: Awaited<ReturnType<SessionGate["awaitStop"]>>) => StopClassification;
  }): Promise<DriveOutcome> {
    const readiness = deps.epicPrReadiness!;
    for (let nudges = 0; ; nudges += 1) {
      const pr = await readiness(args.repo, args.epicNumber);
      if (pr.exists && !pr.isDraft) {
        console.error(`${args.tag} positive done-signal: ready Epic PR — completing`);
        return { kind: "done" };
      }
      if (nudges >= maxNudges) {
        console.error(`${args.tag} no done-signal after ${maxNudges} nudges — parking for a human`);
        return { kind: "nudge-exhausted" };
      }
      console.error(`${args.tag} bare-stop, no ready PR — nudge ${nudges + 1}/${maxNudges}`);
      await deps.tmux.sendText(args.sessionName, "continue");
      await deps.tmux.sendEnter(args.sessionName);
      const stopPayload = await deps.sessionGate.awaitStop(args.sessionName, nudgeStopTimeout);
      const classification = args.classifyAt(stopPayload);
      if (classification.kind !== "bare-stop") return classification;
    }
  }

  async function launchAndDrive(ctx: StepContext<ImplementationInput>): Promise<DriveResult> {
    const { handle } = ctx.steps["prepare-worktree"] as PrepareResult;
    const adapter = deps.getAdapter(ctx.input.adapter);
    const sessionName = sessionNameFor(ctx.input);
    const sessionToken = crypto.randomUUID();
    const tag = `[workflow:${sessionName}]`;

    updateWorkflow(deps.db, ctx.executionId, { state: "launching", sessionName, sessionToken });

    try {
      console.error(`${tag} ensuring .middle/prompt.md exists in worktree`);
      ensurePromptFile(handle.path, ctx.input.epicNumber);

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
      // Clear any orphaned session of the same name left by a prior dispatch
      // that was interrupted (Ctrl-C / crash) before its cleanup ran —
      // otherwise newSession fails with "duplicate session". killSession is a
      // no-op when nothing's there.
      await deps.tmux.killSession(sessionName);
      console.error(`${tag} launching tmux session: ${argv.join(" ")} (cwd=${handle.path})`);
      await deps.tmux.newSession({ sessionName, command: argv, cwd: handle.path, env });

      // Claude pops a bypass-mode warning at boot; SessionStart cannot fire
      // until it is dismissed. Run the dismisser in *parallel* with the
      // SessionStart wait — when it detects the prompt it sends Down+Enter and
      // Claude proceeds past the warning. Fire-and-forget with .catch so a
      // dismiss-side error never becomes an unhandled rejection.
      console.error(`${tag} starting bypass-prompt dismisser (parallel to SessionStart wait)`);
      const dismissPromise = adapter.enterAutoMode({ sessionName }).catch((err: unknown) => {
        console.error(`${tag} enterAutoMode failed: ${(err as Error).message}`);
      });

      // drive: SessionStart yields session_id + transcript_path
      console.error(`${tag} waiting for SessionStart hook (timeout ${launchTimeout}ms)`);
      const startPayload = await deps.sessionGate.awaitSessionStart(sessionName, launchTimeout);
      console.error(
        `${tag} SessionStart received — session_id=${startPayload.session_id ?? "<missing>"}`,
      );
      // dismissPromise will resolve on its own (answered the prompt, or never
      // saw it within the polling window). No further enterAutoMode call.
      void dismissPromise;

      const transcriptPath = adapter.resolveTranscriptPath(startPayload);
      updateWorkflow(deps.db, ctx.executionId, {
        state: "running",
        sessionId:
          typeof startPayload.session_id === "string" ? startPayload.session_id : undefined,
        transcriptPath,
      });

      const promptText = adapter.buildPromptText({
        promptFile: ".middle/prompt.md",
        kind: "initial",
        epicNumber: ctx.input.epicNumber,
      });
      console.error(`${tag} sending prompt: "${promptText}"`);
      await deps.tmux.sendText(sessionName, promptText);
      await deps.tmux.sendEnter(sessionName);

      // observe: the Stop boundary is the signal — not a process exit
      console.error(`${tag} waiting for Stop hook (timeout ${stopTimeout}ms)`);
      const stopPayload = await deps.sessionGate.awaitStop(sessionName, stopTimeout);
      const classifyAt = (payload: typeof stopPayload): StopClassification =>
        adapter.classifyStop({
          payload,
          transcriptPath,
          sentinelPresent: existsSync(join(handle.path, ".middle", "blocked.json")),
          worktree: handle.path,
        });
      const classification = classifyAt(stopPayload);
      console.error(`${tag} Stop received — classification=${classification.kind}`);

      // Positive done-signal (#80): a bare-stop is NOT completion on its own.
      // Only a ready, non-draft Epic PR completes it; otherwise nudge (bounded),
      // then park. When no readiness seam is wired, fall through to the legacy
      // "bare-stop → completed" mapping.
      if (classification.kind === "bare-stop" && deps.epicPrReadiness) {
        const outcome = await resolveBareStop({
          tag,
          sessionName,
          repo: ctx.input.repo,
          epicNumber: ctx.input.epicNumber,
          classifyAt,
        });
        return { outcome, sessionName };
      }
      return { outcome: classification, sessionName };
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
    const { outcome, sessionName } = ctx.steps["launch-and-drive"] as DriveResult;
    await deps.tmux.killSession(sessionName);

    let finalState = finalStateForOutcome(outcome);

    // Plan-comment guard: a dispatch only truly completes if the agent posted
    // its plan as a comment on the Epic. Run it BEFORE destroying the worktree —
    // the plan body is read from the worktree's committed plan.md.
    if (finalState === "completed" && deps.planCommentReader) {
      const planBody = readPlanBody(handle.path, ctx.input.epicNumber);
      const guard = await verifyPlanComment({
        gh: deps.planCommentReader,
        repo: ctx.input.repo,
        epicNumber: ctx.input.epicNumber,
        planBody,
        agentLogin: deps.agentLogin,
      });
      if (!guard.ok) {
        console.error(`[workflow:${sessionName}] ${guard.reason}`);
        finalState = "failed";
      }
    }

    await deps.worktree.destroyWorktree(handle);

    if (outcome.kind === "rate-limited") {
      // Reactive rate-limit: record the durable signal the auto-dispatch loop
      // (Phase 8) reads to delay re-enqueue until reset_at. resetAt is the raw
      // text the transcript carried after "Resets at "; parse it to unix ms,
      // null when unrecognized (RATE_LIMITED with an unknown reset).
      setRateLimited(deps.db, {
        adapter: ctx.input.adapter,
        resetAt: parseResetAt(outcome.resetAt),
        source: "transcript",
        detail: outcome.resetAt,
      });
    } else if (finalState === "completed") {
      // Probe-via-real-work: a completed dispatch proves the adapter is serving
      // again, so a previously RATE_LIMITED adapter reverts to AVAILABLE.
      markAvailableOnSuccess(deps.db, ctx.input.adapter);
    }

    updateWorkflow(deps.db, ctx.executionId, { state: finalState });
  }

  return new Workflow<ImplementationInput>("implementation")
    .step("prepare-worktree", prepareWorktree, { compensate: cleanupWorktree })
    // timeout: must exceed the step's OWN internal waits (launchTimeout for
    // SessionStart + stopTimeout for Stop), or bunqueue's default 30s step
    // timeout fires mid-work and kills the live session. The internal
    // awaitSessionStart/awaitStop timeouts stay the controlling ones (they give
    // specific errors); this is a backstop just above them.
    // retry: 1 — bunqueue's `retry` is `maxAttempts` (loop runs `attempt = 1
    // … <= retry`), not "retries after the first attempt". `1` means exactly
    // one attempt, no retries. Phase 1 fails fast and compensates: retrying a
    // launch piles up tmux/branch state and aggravates bunqueue's
    // job-lifecycle race on the failure path. The full workflow's retry
    // budgets (spec) live on `plan` / `implement-loop`.
    .step("launch-and-drive", launchAndDrive, {
      retry: 1,
      // backstop above the step's own internal waits: SessionStart + the first
      // Stop + up to maxNudges further Stop-awaits (the bare-stop nudge loop).
      timeout: launchTimeout + stopTimeout + maxNudges * nudgeStopTimeout + 60_000,
    })
    .step("cleanup", cleanup);
}
