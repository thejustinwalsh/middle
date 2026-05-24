import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { AgentAdapter, StopClassification } from "@middle/core";
import { Workflow } from "bunqueue/workflow";
import type { StepContext } from "bunqueue/workflow";
import type { SessionGate } from "../hook-server.ts";
import { markAvailableOnSuccess, parseResetAt, setRateLimited } from "../rate-limits.ts";
import type { CreateWorktreeOpts, WorktreeHandle } from "../worktree.ts";
import {
  armWaitForSignal,
  consumeWaitForSignal,
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

/**
 * Which pause kind the workflow parked on. The two pause kinds share one
 * park → external-signal → resume spine; the reason is what the resume step
 * uses to pick its re-priming framing (`answer` vs `resume`/review-changes).
 */
export type ResumeReason = "answered-question" | "review-changes";

/**
 * The single bunqueue signal event the workflow's top-level `waitFor` listens
 * on. bunqueue's `waitFor(event)` takes a *static* string and `engine.signal`
 * targets a specific execution by id, so one constant event name suffices —
 * the epic-scoped, reason-scoped name lives in the durable `waitfor_signals`
 * row (see `signalNameFor`), which is what the poller and dashboard read.
 */
export const RESUME_EVENT = "resume";

/** The durable, poller-facing signal name for a workflow's armed wait. */
export function signalNameFor(epicNumber: number, reason: ResumeReason): string {
  return reason === "review-changes"
    ? `epic-${epicNumber}-review-resolved`
    : `epic-${epicNumber}-answered`;
}

/** The `waitFor` timeout — a parked workflow waits up to a week for its signal. */
const WAITFOR_TIMEOUT_MS = 7 * 24 * 3600 * 1000;

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
   * Post the agent's open question on the Epic for human visibility when it
   * parks on `asked-question`. Receives the sentinel contents `classifyStop`
   * surfaced (`question` + optional `context`). Optional + injectable so tests
   * need no `gh`; the default (wired by the dispatcher) comments on the issue.
   */
  postQuestion?: (opts: {
    repo: string;
    epicNumber: number;
    question: string;
    context?: string;
  }) => Promise<void>;
};

const DEFAULT_LAUNCH_TIMEOUT_MS = 90_000;
const DEFAULT_STOP_TIMEOUT_MS = 4 * 60 * 60 * 1000;

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

/** A park-worthy stop ends the session and waits for a human/reviewer signal. */
function isParkKind(kind: StopClassification["kind"]): boolean {
  return kind === "asked-question" || kind === "done";
}

/** The resume reason a park-worthy classification maps to. */
function reasonFor(kind: StopClassification["kind"]): ResumeReason {
  return kind === "done" ? "review-changes" : "answered-question";
}

/** The terminal `workflows.state` a settled classification resolves to. */
function finalStateFor(classification: StopClassification): WorkflowState {
  switch (classification.kind) {
    case "done":
      return "completed";
    case "failed":
      return "failed";
    case "rate-limited":
      return "rate-limited";
    case "asked-question":
      // A resumed asked-question that did not settle stays parked for a human;
      // a single-cycle resume cannot re-park in this execution (re-park is the
      // re-enqueue path, sub-issue #36).
      return "waiting-human";
    case "bare-stop":
      // the minimal spine has no nudge loop — a clean stop is terminal here
      return "completed";
  }
}

type PrepareResult = { handle: WorktreeHandle };
type DriveResult = { classification: StopClassification; sessionName: string };

/**
 * The `implementation` workflow with the Phase 5 park → external-signal →
 * resume spine:
 *
 *   prepare-worktree → launch-and-drive → branch(park | terminal)
 *     → waitFor(RESUME_EVENT) → resume-or-finalize
 *
 * `launch-and-drive` runs the launch → drive → observe loop and ends the
 * session at the `Stop` boundary (every classify outcome frees the slot). The
 * branch arms a durable `waitfor_signals` row and parks the workflow in
 * `waiting-human` for park-worthy stops (`asked-question`, `done`), or — for
 * terminal stops — pre-seeds the signal so the single top-level `waitFor` falls
 * through without parking. `resume-or-finalize` consumes the signal and
 * re-drives a fresh session on resume, then finalizes (worktree teardown +
 * terminal state).
 *
 * bunqueue's branch `.path()` bodies and loop bodies are *steps only* — a
 * `waitFor` nested inside is silently dropped — and `engine.signal(id, event)`
 * targets one execution, so the `waitFor` is a single top-level node and the
 * loop-back for additional review rounds is re-enqueue (sub-issue #36).
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

  /**
   * Launch (or resume) one interactive session in the worktree, drive one turn,
   * and classify the `Stop`. Ends the session before returning — at `Stop` the
   * turn is over and the slot frees regardless of outcome ("END SESSION" in the
   * dispatch lifecycle). Shared by the initial drive and the resume drive.
   */
  async function driveOnce(
    ctx: StepContext<ImplementationInput>,
    handle: WorktreeHandle,
    promptKind: "initial" | "resume" | "answer",
  ): Promise<DriveResult> {
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
      // (or this workflow's own prior drive) before its cleanup ran — otherwise
      // newSession fails with "duplicate session". killSession is a no-op when
      // nothing's there.
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
        kind: promptKind,
        epicNumber: ctx.input.epicNumber,
      });
      console.error(`${tag} sending prompt (${promptKind}): "${promptText}"`);
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
      // END SESSION — the turn is over; free the slot before parking/finalizing.
      await deps.tmux.killSession(sessionName);
      return { classification, sessionName };
    } catch (error) {
      // never leak a tmux session on the failure path; the compensation rolls
      // back the worktree
      console.error(`${tag} drive failed: ${(error as Error).message}`);
      await deps.tmux.killSession(sessionName);
      throw error;
    }
  }

  async function launchAndDrive(ctx: StepContext<ImplementationInput>): Promise<DriveResult> {
    const { handle } = ctx.steps["prepare-worktree"] as PrepareResult;
    return driveOnce(ctx, handle, "initial");
  }

  /**
   * Park-worthy stop: arm the durable `waitfor_signals` row under the
   * epic-scoped, reason-scoped name the poller watches, set `waiting-human`,
   * and (for `asked-question`) post the question for human visibility. The
   * session already ended in `driveOnce`. The top-level `waitFor` that follows
   * then parks the execution because RESUME_EVENT is unset.
   */
  async function parkForResume(ctx: StepContext<ImplementationInput>): Promise<void> {
    const { classification } = ctx.steps["launch-and-drive"] as DriveResult;
    const reason = reasonFor(classification.kind);
    armWaitForSignal(
      deps.db,
      signalNameFor(ctx.input.epicNumber, reason),
      ctx.executionId,
      JSON.stringify({ reason }),
    );
    updateWorkflow(deps.db, ctx.executionId, { state: "waiting-human" });
    if (classification.kind === "asked-question" && deps.postQuestion) {
      try {
        await deps.postQuestion({
          repo: ctx.input.repo,
          epicNumber: ctx.input.epicNumber,
          question: classification.sentinel?.question ?? "(question text unavailable)",
          context: classification.sentinel?.context,
        });
      } catch (error) {
        // Visibility is best-effort — the wait is already armed and durable, so
        // a failed comment must not abort the park.
        console.error(`[workflow] postQuestion failed: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Terminal stop: record rate-limit bookkeeping and pre-seed RESUME_EVENT so
   * the single top-level `waitFor` falls through without parking. The final
   * `workflows.state` is set in `resume-or-finalize` (alongside worktree
   * teardown), so all terminal handling lives in one place. `ctx.signals` is
   * the live `exec.signals` (passed by reference), which is exactly what the
   * downstream `waitFor` reads.
   */
  async function recordTerminal(ctx: StepContext<ImplementationInput>): Promise<void> {
    const { classification } = ctx.steps["launch-and-drive"] as DriveResult;
    if (classification.kind === "rate-limited") {
      setRateLimited(deps.db, {
        adapter: ctx.input.adapter,
        resetAt: parseResetAt(classification.resetAt),
        source: "transcript",
        detail: classification.resetAt,
      });
    }
    (ctx.signals as Record<string, unknown>)[RESUME_EVENT] = { terminal: true };
  }

  /**
   * Reached after the `waitFor` resolves. Terminal stops fall straight through
   * (the signal was pre-seeded). Park-worthy stops only reach here once the
   * poller has fired `engine.signal(id, RESUME_EVENT, …)` — so consume the
   * durable row and re-drive a fresh session re-primed per reason, then
   * finalize on the resumed outcome. Worktree teardown + terminal state happen
   * here, once, for every path.
   */
  async function resumeOrFinalize(ctx: StepContext<ImplementationInput>): Promise<void> {
    const { handle } = ctx.steps["prepare-worktree"] as PrepareResult;
    const initial = ctx.steps["launch-and-drive"] as DriveResult;

    let settled = initial.classification;
    if (isParkKind(initial.classification.kind)) {
      // We were resumed: consume the durable wait record and re-drive.
      consumeWaitForSignal(deps.db, ctx.executionId);
      const reason = reasonFor(initial.classification.kind);
      const promptKind = reason === "answered-question" ? "answer" : "resume";
      const resumed = await driveOnce(ctx, handle, promptKind);
      settled = resumed.classification;
    }

    // Finalize: tear the worktree down and resolve the terminal state.
    await deps.worktree.destroyWorktree(handle);
    if (settled.kind !== "rate-limited" && finalStateFor(settled) === "completed") {
      // Probe-via-real-work: a completed dispatch proves the adapter is serving
      // again, so a previously RATE_LIMITED adapter reverts to AVAILABLE.
      markAvailableOnSuccess(deps.db, ctx.input.adapter);
    } else if (settled.kind === "rate-limited") {
      setRateLimited(deps.db, {
        adapter: ctx.input.adapter,
        resetAt: parseResetAt(settled.resetAt),
        source: "transcript",
        detail: settled.resetAt,
      });
    }
    updateWorkflow(deps.db, ctx.executionId, { state: finalStateFor(settled) });
  }

  return (
    new Workflow<ImplementationInput>("implementation")
      .step("prepare-worktree", prepareWorktree, { compensate: cleanupWorktree })
      // timeout: must exceed the step's OWN internal waits (launchTimeout for
      // SessionStart + stopTimeout for Stop), or bunqueue's default 30s step
      // timeout fires mid-work and kills the live session. The internal
      // awaitSessionStart/awaitStop timeouts stay the controlling ones (they
      // give specific errors); this is a backstop just above them. retry: 1 —
      // bunqueue's `retry` is `maxAttempts`; `1` means one attempt, no retries.
      .step("launch-and-drive", launchAndDrive, {
        retry: 1,
        timeout: launchTimeout + stopTimeout + 60_000,
      })
      .branch((ctx) =>
        isParkKind((ctx.steps["launch-and-drive"] as DriveResult).classification.kind)
          ? "park"
          : "terminal",
      )
      .path("park", (w) => w.step("park-for-resume", parkForResume))
      .path("terminal", (w) => w.step("record-terminal", recordTerminal))
      // Single top-level `waitFor`: parks park-worthy stops until the poller
      // fires RESUME_EVENT; terminal stops pre-seeded the signal and fall
      // through. Same timeout budget as the drive step.
      .waitFor(RESUME_EVENT, { timeout: WAITFOR_TIMEOUT_MS })
      .step("resume-or-finalize", resumeOrFinalize, {
        retry: 1,
        timeout: launchTimeout + stopTimeout + 60_000,
      })
  );
}
