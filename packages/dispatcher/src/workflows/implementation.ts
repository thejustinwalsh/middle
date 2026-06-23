import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import type { AgentAdapter, HookPayload, StopClassification } from "@middle/core";
import { Workflow } from "bunqueue/workflow";
import type { StepContext } from "bunqueue/workflow";
import { type PlanCommentReader, verifyPlanComment } from "../gates/plan-comment.ts";
import type { SessionGate } from "../hook-server.ts";
import { CI_FAILED_DECISION, type ResumeSignalPayload } from "../poller.ts";
import { markAvailableOnSuccess, parseResetAt, setRateLimited } from "../rate-limits.ts";
import type { CreateWorktreeOpts, WorktreeHandle } from "../worktree.ts";
import {
  armWaitForSignal,
  consumeWaitForSignal,
  createWorkflowRecord,
  updateWorkflow,
  type WorkflowState,
} from "../workflow-record.ts";

/**
 * The handoff carried by a continuation execution. A park can only happen once
 * per bunqueue execution (no loop-back; loop bodies can't hold a `waitFor`), so
 * every resume is a *fresh* execution re-primed from this — reusing the prior
 * round's worktree (no new branch / PR) and re-driving from the resume brief.
 */
export type ResumeInput = {
  reason: ResumeReason;
  /** Review-pass counter; one round = one whole `CHANGES_REQUESTED` pass. */
  round: number;
  /** The worktree handle from the prior round — reused verbatim. */
  worktree: WorktreeHandle;
  /** What the poller fired: the human's reply, or the review verdict. */
  payload: ResumeSignalPayload;
};

/** A dispatch unit: an Epic (or standalone issue) pointed at one adapter. */
export type ImplementationInput = {
  repo: string;
  epicRef: string;
  adapter: string;
  /**
   * How the dispatch was initiated: `"manual"` (`mm dispatch`) or `"auto"` (the
   * auto-dispatch loop). Recorded on the workflow row's `meta_json`. Defaults to
   * `"auto"` when omitted; a continuation carries its origin forward.
   */
  source?: "manual" | "auto";
  /**
   * Present only on a continuation execution (a resume). Absent on the initial
   * dispatch. When set, `prepare-worktree` reuses `resume.worktree` instead of
   * creating one, and writes the reason-specific resume brief to
   * `.middle/prompt.md` before the drive.
   */
  resume?: ResumeInput;
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
export function signalNameFor(epicRef: string, reason: ResumeReason): string {
  return reason === "review-changes"
    ? `epic-${epicRef}-review-resolved`
    : `epic-${epicRef}-answered`;
}

/** Default cadence for the drive's session-liveness probe (production). */
const DEFAULT_LIVENESS_POLL_MS = 5000;

/** How the drive's Stop wait ended. */
export type StopWaitResult =
  | { via: "stop"; payload: HookPayload }
  | { via: "session-ended" }
  | { via: "timeout" };

/**
 * Wait for the agent's turn boundary, but don't trust the Stop hook to be the
 * only way the wait ends. The interactive process doesn't exit between turns, so
 * `awaitStop` is the normal signal — but a hung agent may never fire Stop, and a
 * watchdog idle-kill (or any crash) takes the session out from under us. So we
 * race three outcomes: the Stop hook arrives (`stop`), the tmux session goes
 * away (`session-ended`), or the Stop wait's own timeout elapses (`timeout`).
 *
 * The caller decides what each means: a `stop` is classified as usual; a
 * `session-ended`/`timeout` is a park when the agent left a `blocked.json`
 * sentinel, a failure otherwise. Liveness-probe errors are inconclusive and
 * ignored (mirrors the watchdog) — the probe never *causes* a false end, it only
 * reports a confirmed-dead session. `isAlive` absent → Stop-or-timeout only.
 */
export async function awaitStopOrSessionEnd(opts: {
  awaitStop: (timeoutMs: number) => Promise<HookPayload>;
  timeoutMs: number;
  isAlive?: () => Promise<boolean>;
  pollMs?: number;
}): Promise<StopWaitResult> {
  const pollMs = opts.pollMs ?? DEFAULT_LIVENESS_POLL_MS;
  let poller: ReturnType<typeof setInterval> | undefined;
  try {
    const stop: Promise<StopWaitResult> = opts
      .awaitStop(opts.timeoutMs)
      .then((payload) => ({ via: "stop" as const, payload }))
      // The gate rejects only when the Stop wait elapses; treat any rejection
      // as "no Stop arrived" rather than crashing the drive.
      .catch(() => ({ via: "timeout" as const }));

    if (!opts.isAlive) return await stop;

    const probe = opts.isAlive;
    const sessionEnded = new Promise<StopWaitResult>((resolve) => {
      poller = setInterval(() => {
        // Inconclusive probe (e.g. tmux server momentarily unreachable) must
        // not be read as a dead session — only a confirmed `false` ends the wait.
        probe()
          .then((alive) => {
            if (!alive) resolve({ via: "session-ended" });
          })
          .catch(() => {});
      }, pollMs);
    });

    return await Promise.race([stop, sessionEnded]);
  } finally {
    if (poller) clearInterval(poller);
  }
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
  /**
   * Session liveness, used by the drive to notice a session killed out from
   * under it (e.g. a watchdog idle-kill) instead of blocking on the Stop hook
   * for the full `stopTimeout`. Optional: when absent the drive falls back to
   * Stop-or-timeout. Production wires tmux `status`.
   */
  status?(sessionName: string): Promise<{ alive: boolean }>;
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
  /** Cadence for the drive's session-liveness probe; defaults to 5s. */
  livenessPollMs?: number;
  /**
   * Surface the agent's pause on the Epic for human visibility when it parks on
   * `asked-question`. Receives the sentinel contents `classifyStop` surfaced
   * (`question` + optional `context`) plus the pause `kind`: a `"complexity"`
   * pause is surfaced so the recommender classifies it under the `complexity
   * pause` state-issue label, vs. a plain `"question"`. Optional + injectable so
   * tests need no `gh`; the default (wired by the dispatcher) comments on the issue.
   */
  postQuestion?: (opts: {
    repo: string;
    epicRef: string;
    question: string;
    context?: string;
    kind: "question" | "complexity";
  }) => Promise<void>;
  /**
   * The repo's `complexity_ceiling` (`[limits] complexity_ceiling`, default 3) —
   * the max fork branching factor the agent resolves itself before pausing the
   * sub-issue (build spec → "Complexity and architectural forks"). Injected into
   * the dispatch brief so the agent knows its fork budget. Resolved per repo
   * (the deps are shared across repos); defaults to 3 when unwired.
   */
  resolveComplexityCeiling?: (repo: string) => number | Promise<number>;
  /**
   * Whether the Epic carries the `approved` label — a human has reviewed its
   * scope and authorized the agent to proceed past a complexity overrun with a
   * best-judgment call instead of pausing (#53). Reflected in the dispatch brief.
   * Optional + injectable; defaults to `false` (not approved) when unwired.
   */
  isEpicApproved?: (repo: string, epicRef: string) => boolean | Promise<boolean>;
  /**
   * Enqueue a continuation execution for the next round (a resume). Injected so
   * the workflow stays free of the engine: in prod the dispatcher wires this to
   * `engine.start("implementation", input)` on the long-lived engine that hosts
   * parked executions; tests wire it to their embedded engine. The continuation
   * reuses the prior round's worktree via `input.resume.worktree`.
   */
  enqueueContinuation: (input: ImplementationInput) => Promise<void>;
  /**
   * The repo's Epic-store mode — selects which `references/<mode>-mode-commands.md`
   * the dispatch brief mirrors into the worktree (the agent reads only the
   * incantations that apply to its run). Injected so the workflow stays db-free;
   * the dispatcher wires it to `readEpicStoreConfig`. Defaults to `"github"`.
   */
  resolveEpicStoreMode?: (repo: string) => "github" | "file" | Promise<"github" | "file">;
  /**
   * The review-round ceiling: after this many `CHANGES_REQUESTED` passes without
   * an `APPROVED`, the workflow parks in `waiting-human` and stops auto-resuming
   * (a never-satisfied loop must not run forever). Defaults to 5.
   */
  reviewRoundCap?: number;
  /**
   * Positive done-signal (skill enforcement #80): the only thing that turns a
   * `bare-stop` into completion is a ready, non-draft Epic PR. When wired, a
   * `bare-stop` without that signal nudges the agent (bounded) instead of
   * finalizing; without it, the legacy "bare-stop → completed" mapping holds.
   */
  epicPrReadiness?: (
    repo: string,
    epicRef: string,
  ) => Promise<{ exists: boolean; isDraft: boolean }>;
  /** Max "continue" nudges on a bare-stop before parking in waiting-human. */
  maxNudges?: number;
  /** Per-nudge Stop-await timeout. */
  nudgeStopTimeoutMs?: number;
  /**
   * Plan-comment guard (skill enforcement #1): when wired, a `done` dispatch only
   * truly completes if a comment on the Epic carries the plan body. Optional so
   * gate-free unit tests keep their unguarded completion behavior.
   */
  planCommentReader?: PlanCommentReader;
  /**
   * Verify-on-stop gate: run the repo's `verify.toml` gates when the agent
   * claims `done`, BEFORE it parks for review. Returns `ok` + a human-readable
   * `report` of the failures. The dispatcher wires it to
   * `loadVerifyConfig` + `runGates` in the worktree; optional, so a repo with no
   * `verify.toml` (or a gate-free unit test) skips the enforcement. This is the
   * first point gates run in a live dispatch (the per-push trigger is #101).
   */
  runVerifyGates?: (worktree: string) => Promise<{ ok: boolean; report: string }>;
  /** Max verify-fix nudges on a `done` before parking in waiting-human (default 3). */
  verifyRoundCap?: number;
  /** The agent's gh account — restricts the plan-comment match to its comments. */
  agentLogin?: string;
};

const DEFAULT_LAUNCH_TIMEOUT_MS = 90_000;
const DEFAULT_STOP_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const DEFAULT_REVIEW_ROUND_CAP = 5;
const DEFAULT_MAX_NUDGES = 3;
const DEFAULT_NUDGE_STOP_TIMEOUT_MS = 30 * 60 * 1000;
/** Spec default for `[limits] complexity_ceiling` when no per-repo resolver is wired. */
const DEFAULT_COMPLEXITY_CEILING = 3;
const DEFAULT_VERIFY_ROUND_CAP = 3;

/**
 * Session names are deterministic so compensations can recompute them, and
 * namespaced by repo so concurrent dispatches of the same issue number across
 * different repos don't collide on one tmux session (which would make the
 * second dispatch's failure-path `killSession` tear down the first's live
 * session). Matches the repo-namespaced worktree path layout.
 */
function sessionNameFor(input: ImplementationInput): string {
  const repoSlug = input.repo.replace(/[^A-Za-z0-9_-]/g, "-");
  return `middle-${repoSlug}-${input.epicRef}`;
}

/**
 * Write the default dispatch brief to `.middle/prompt.md` if one isn't already
 * present. The skill (invoked by the slash command) reads this file as its
 * operating brief — framing, not "use the skill" (the slash command already
 * did that). An operator-supplied brief (committed in the repo, or written by a
 * future `mm dispatch --note` / the recommender) is left untouched.
 */
function ensurePromptFile(
  worktreePath: string,
  epicRef: string,
  complexityCeiling: number,
  approved: boolean,
  mode: "github" | "file",
): void {
  const middleDir = join(worktreePath, ".middle");
  const promptPath = join(middleDir, "prompt.md");
  if (existsSync(promptPath)) return;
  mkdirSync(middleDir, { recursive: true });
  writeFileSync(promptPath, defaultDispatchBrief(epicRef, complexityCeiling, approved, mode));
}

/** The skill whose mode-specific command reference the dispatch brief mirrors. */
const MODE_COMMANDS_SKILL = "implementing-github-issues";

/**
 * Mirror the run's mode-specific commands reference into the worktree so the
 * agent's implementer skill reads only the incantations that apply to its Epic
 * store. Copies `<worktree>/.claude/skills/<skill>/references/<mode>-mode-commands.md`
 * (installed by `mm init`) to `<worktree>/.middle/skills/<skill>/references/` — the
 * mode-resolved single file the dispatch brief points the agent at. Best-effort: a
 * worktree whose installed skill predates the per-mode references (no source file)
 * is a no-op, never a dispatch failure.
 */
function mirrorModeCommands(worktreePath: string, mode: "github" | "file"): void {
  const rel = join("skills", MODE_COMMANDS_SKILL, "references", `${mode}-mode-commands.md`);
  const src = join(worktreePath, ".claude", rel);
  if (!existsSync(src)) return;
  const dest = join(worktreePath, ".middle", rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

/**
 * The default dispatch brief written to `.middle/prompt.md`. Carries the repo's
 * `complexity_ceiling` so the agent knows its fork budget (the max candidate
 * forks it may resolve itself before pausing the sub-issue). When the Epic
 * carries the `approved` label, the brief authorizes the agent to proceed past a
 * complexity overrun with a best-judgment call instead of pausing (build spec →
 * "Complexity and architectural forks"; #53).
 *
 * The `mode` is the Epic store mode (`"github"` or `"file"`); it appears in the
 * operator-notes section so the agent knows which mode-specific commands
 * reference file to read from `.middle/skills/implementing-github-issues/references/`.
 */
export function defaultDispatchBrief(
  epicRef: string,
  complexityCeiling: number,
  approved: boolean,
  mode: "github" | "file",
): string {
  const complexityRule = approved
    ? `- This Epic carries the \`approved\` label: a human has reviewed its scope and
  authorized you to proceed past a complexity overrun. If a sub-issue decision
  would need more than ${complexityCeiling} candidate forks (the complexity ceiling),
  do NOT pause — make a best-judgment call within the ceiling and keep going.`
    : `- Pause only if you are genuinely blocked: ambiguous acceptance criteria, or a
  decision needing more than ${complexityCeiling} candidate forks (the complexity
  ceiling) to resolve. To pause, write \`.middle/blocked.json\` and exit; for a
  complexity overrun include \`"kind": "complexity"\` in it.`;
  const refsPath = `.middle/skills/implementing-github-issues/references/`;
  const modeNote = `- This dispatch runs in **${mode} mode**. The mode-specific command reference is
  the single file in \`${refsPath}\` — read it before issuing any gh/git commands.`;
  return `# middle dispatch brief — Epic #${epicRef}

You are running autonomously under middle. There is no human watching in real
time. Operating rules for this dispatch:

- Work through every phase continuously. The mechanical verification gates are
  the gates between phases — do not pause for confirmation between them.
- Do not stop to ask questions you can resolve yourself.
${complexityRule}
- The terminal state is: every phase verified, the PR marked ready for review,
  and the reviewer's brief posted on both the Epic and the PR. Then stop.

## Operator notes for this dispatch
${modeNote}
`;
}

/**
 * Overwrite `.middle/prompt.md` with the reason-specific resume brief for a
 * continuation execution. The agent re-reads this on its `@`-referenced resume
 * drive (`buildPromptText` kind `answer` / `resume`):
 *
 * - `answered-question` — inlines the human's reply so the agent reads the
 *   answer and continues the workstream.
 * - `review-changes` — an "address review" brief. The agent pulls the PR's
 *   review threads itself (`gh`) and follows the `implementing-github-issues`
 *   skill's "Addressing review feedback" procedure (batch → internal review
 *   loop → push once → reply in-thread → re-request review → re-park). Carries
 *   the round and cap so a bounded loop is visible to the agent.
 *
 * This unconditionally overwrites (unlike `ensurePromptFile`, which preserves an
 * operator brief on the *initial* dispatch) — a resume's brief is the live one.
 */
function writeResumeBrief(
  worktreePath: string,
  epicRef: string,
  resume: ResumeInput,
  reviewRoundCap: number,
): void {
  const middleDir = join(worktreePath, ".middle");
  mkdirSync(middleDir, { recursive: true });
  const promptPath = join(middleDir, "prompt.md");
  const operatingRules = `## Operating rules for this dispatch

- You are running autonomously under middle. There is no human watching in real
  time. Continue the workstream — do not restart it. The branch, draft PR,
  \`plan.md\`, and \`decisions.md\` are all intact.
- Work continuously; pause only if you are genuinely blocked (write
  \`.middle/blocked.json\` and exit). The terminal state is the PR marked ready.
`;

  if (resume.reason === "answered-question") {
    const reply = resume.payload.reason === "answered-question" ? resume.payload.reply : undefined;
    const answer = reply
      ? `> ${reply.body.replace(/\n/g, "\n> ")}\n\n— @${reply.authorLogin}`
      : "(the human's reply text was unavailable — check the Epic thread on GitHub)";
    writeFileSync(
      promptPath,
      `# middle dispatch brief — Epic #${epicRef} (resumed: a human answered)

A human answered the open question you parked on. Their reply:

${answer}

Read this answer, fold it into your plan / decisions log, and continue the
workstream from where you left off.

${operatingRules}`,
    );
    return;
  }

  // review-changes
  const decision = resume.payload.reason === "review-changes" ? resume.payload.decision : null;

  // CI-failure resume (#CI gate): a red build, not review feedback. The agent
  // pulls the failing checks itself and fixes them — a distinct brief from the
  // address-review one (there are no review threads to work, just broken CI).
  if (decision === CI_FAILED_DECISION) {
    writeFileSync(
      promptPath,
      `# middle dispatch brief — Epic #${epicRef} (resumed: CI is failing — round ${resume.round} of ${reviewRoundCap})

The PR's CI is **red** — a PR can't be reviewed until it builds. Investigate and
fix the failing checks now:

1. Pull the failing checks yourself: \`gh pr checks\` for the rollup, then
   \`gh run view <run-id> --log-failed\` (or the check's details URL) to read the
   actual failure — don't guess from the check name.
2. Reproduce locally where you can (run the failing gate/test), fix the **cause**,
   and add a regression test if the failure was a real defect, not flake.
3. **Push once** for the whole fix, then stop. The workflow re-parks and re-checks
   CI on the next poll; a green build (plus review) is what ends the loop.

This is round ${resume.round} of ${reviewRoundCap}. After ${reviewRoundCap} rounds without resolution the
workflow parks for a human and stops auto-resuming.

${operatingRules}`,
    );
    return;
  }

  writeFileSync(
    promptPath,
    `# middle dispatch brief — Epic #${epicRef} (resumed: address review — round ${resume.round} of ${reviewRoundCap})

A reviewer requested changes on the PR${decision ? ` (decision: ${decision})` : ""}. Address this
review pass now, following the \`implementing-github-issues\` skill's
**"Addressing review feedback"** procedure:

1. Pull **every** open review thread on the PR yourself via \`gh\` (the review
   comments and the review bodies). Read the whole pass before changing anything.
2. **Batch** the findings and resolve each **class-wide** — a fix plus a test per
   fix, not one comment at a time.
3. Run the **internal clean-eyes review loop** over the batched diff (a review
   subagent), looping until it surfaces nothing new, to catch adjacent edges
   before re-review.
4. **Push once** — one push for the whole pass, not per fix. Do NOT post
   \`@coderabbitai review\` after pushing — a push auto-triggers CodeRabbit.
   Only post \`@coderabbitai resume\` if CodeRabbit's own notice says it paused.
5. Reply in-thread to each addressed comment, then stop.
   The workflow re-parks for the next verdict.

This is review round ${resume.round} of ${reviewRoundCap}. After ${reviewRoundCap} rounds without an
\`APPROVED\` the workflow parks for a human and stops auto-resuming.

${operatingRules}`,
  );
}

/**
 * The drive loop's resolved outcome: a `StopClassification` plus one
 * dispatcher-only terminal `nudge-exhausted` (#80) — a `bare-stop` that never
 * produced a positive done-signal within the nudge budget. Kept out of the core
 * `StopClassification` union: a single Stop is never "nudge-exhausted"; only the
 * loop is.
 */
type DriveOutcome = StopClassification | { kind: "nudge-exhausted" };

/** A park-worthy stop ends the session and waits for a human/reviewer signal. */
function isParkKind(kind: DriveOutcome["kind"]): boolean {
  return kind === "asked-question" || kind === "done";
}

/** The resume reason a park-worthy outcome maps to. */
function reasonFor(kind: DriveOutcome["kind"]): ResumeReason {
  return kind === "done" ? "review-changes" : "answered-question";
}

/** Read the workstream's committed plan from the worktree (for the plan-comment guard). */
function readPlanBody(worktreePath: string, epicRef: string): string {
  try {
    return readFileSync(
      join(worktreePath, "planning", "issues", String(epicRef), "plan.md"),
      "utf8",
    );
  } catch {
    return "";
  }
}

/** The terminal `workflows.state` a settled outcome resolves to. */
function finalStateFor(outcome: DriveOutcome): WorkflowState {
  switch (outcome.kind) {
    case "done":
      return "completed";
    case "failed":
      return "failed";
    case "rate-limited":
      return "rate-limited";
    case "asked-question":
      // Defensive only: park kinds (`asked-question`, `done`) route to
      // `parkForResume`, not here — a resume re-enqueues a continuation.
      return "waiting-human";
    case "nudge-exhausted":
      // #80: bounded nudges produced no positive done-signal — park for a human.
      return "waiting-human";
    case "bare-stop":
      // legacy: no positive-done-signal seam wired, so a clean stop completes.
      return "completed";
  }
}

type PrepareResult = { handle: WorktreeHandle };
type DriveResult = { outcome: DriveOutcome; sessionName: string };

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
  const reviewRoundCap = deps.reviewRoundCap ?? DEFAULT_REVIEW_ROUND_CAP;
  const maxNudges = deps.maxNudges ?? DEFAULT_MAX_NUDGES;
  const nudgeStopTimeout = deps.nudgeStopTimeoutMs ?? DEFAULT_NUDGE_STOP_TIMEOUT_MS;
  const verifyRoundCap = deps.verifyRoundCap ?? DEFAULT_VERIFY_ROUND_CAP;

  // Worst-case count of in-session `awaitStop(nudgeStopTimeout)` waits a single
  // drive can spend, used to size the launch-and-drive step backstop so it can't
  // fire mid-retry. Two nested bounded loops contribute:
  //   • the initial bare-stop done-signal loop — up to `maxNudges` waits; and
  //   • the verify-on-stop loop — up to `verifyRoundCap` rounds, and EACH round's
  //     re-stop can itself be a bare-stop that re-enters `resolveBareStop` for up
  //     to `maxNudges` further waits → `verifyRoundCap * (1 + maxNudges)`.
  // (The initial stop is one or the other, but budgeting their sum is a safe
  // superset.) With the defaults (3, 3): 3 + 3*4 = 15 nudge waits.
  const maxNudgeStopWaits = maxNudges + verifyRoundCap * (1 + maxNudges);

  /**
   * Await the next Stop boundary, liveness-aware. The interactive process never
   * exits between turns, so the Stop hook is the normal signal — but a hung
   * agent may never fire it and a watchdog idle-kill removes the session. Race
   * the Stop hook against session-death and the wait timeout
   * (`awaitStopOrSessionEnd`). When no Stop arrives but a `blocked.json` sentinel
   * is present, classify it as the park (the synthetic payload is ignored by
   * `classifyStop` once the sentinel is seen) so the saga never compensates and
   * the worktree survives; with no sentinel it's a genuine dead/hung session —
   * throw so the drive fails. Every in-drive Stop wait (initial + nudge + verify)
   * routes through here so the self-heal is uniform.
   */
  async function awaitNextStop(args: {
    tag: string;
    sessionName: string;
    worktree: string;
    timeoutMs: number;
    classifyAt: (payload: HookPayload) => StopClassification;
    /** Workflow DB id; when provided, writes `end_reason` before throwing on abnormal end. */
    workflowId?: string;
  }): Promise<StopClassification> {
    const probeStatus = deps.tmux.status;
    const waitResult = await awaitStopOrSessionEnd({
      awaitStop: (timeoutMs) => deps.sessionGate.awaitStop(args.sessionName, timeoutMs),
      timeoutMs: args.timeoutMs,
      isAlive: probeStatus ? async () => (await probeStatus(args.sessionName)).alive : undefined,
      pollMs: deps.livenessPollMs,
    });
    if (waitResult.via === "stop") return args.classifyAt(waitResult.payload);
    if (existsSync(join(args.worktree, ".middle", "blocked.json"))) {
      // Self-heal: no Stop arrived (session killed/crashed, or the wait timed
      // out) but the agent declared itself blocked. Park it for human resume —
      // throwing here would compensate the saga and prune the worktree the
      // resume needs, orphaning the armed signal (the #60 failure mode).
      console.error(`${args.tag} ${waitResult.via} with blocked.json present — parking for resume`);
      return args.classifyAt({ reason: waitResult.via } as HookPayload);
    }
    // A dead/hung session with no sentinel is a genuine failure: record the
    // specific reason in the workflow row (for the dashboard Activity view)
    // before throwing so the saga's compensation doesn't clobber it.
    if (args.workflowId) {
      const endReason =
        waitResult.via === "timeout" ? "Stop-hook-timed-out" : "session-ended-before-Stop";
      updateWorkflow(deps.db, args.workflowId, { endReason });
    }
    throw new Error(
      waitResult.via === "timeout"
        ? `Stop wait timed out after ${args.timeoutMs}ms`
        : "session ended before Stop hook",
    );
  }

  /**
   * Resolve a `bare-stop` into a terminal outcome (#80). Completion requires a
   * ready, non-draft Epic PR; without it, send a same-session "continue" nudge
   * and re-await the Stop, up to `maxNudges`. A nudge that yields a definitive
   * classification short-circuits; exhausting the budget parks for a human.
   */
  async function resolveBareStop(args: {
    tag: string;
    sessionName: string;
    worktree: string;
    repo: string;
    epicRef: string;
    classifyAt: (payload: Awaited<ReturnType<SessionGate["awaitStop"]>>) => StopClassification;
    workflowId?: string;
  }): Promise<DriveOutcome> {
    const readiness = deps.epicPrReadiness!;
    for (let nudges = 0; ; nudges += 1) {
      const pr = await readiness(args.repo, args.epicRef);
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
      const classification = await awaitNextStop({
        tag: args.tag,
        sessionName: args.sessionName,
        worktree: args.worktree,
        timeoutMs: nudgeStopTimeout,
        classifyAt: args.classifyAt,
        workflowId: args.workflowId,
      });
      if (classification.kind !== "bare-stop") return classification;
    }
  }

  /**
   * Verify-on-stop (skill enforcement): a `done` only stands if the repo's
   * `verify.toml` gates pass. Runs them in the worktree; on failure, nudges the
   * agent IN-SESSION with the gate report ("fix these and continue") and
   * re-awaits the Stop, up to `verifyRoundCap`. A re-classification that is no
   * longer `done` (the agent asked a question, etc.) is handed back as-is;
   * exhausting the budget parks for a human (worktree kept) rather than shipping
   * an unverified PR. No `runVerifyGates` seam (or no `verify.toml`) → no-op.
   */
  async function enforceVerifyOnDone(args: {
    tag: string;
    sessionName: string;
    worktree: string;
    repo: string;
    epicRef: string;
    classifyAt: (payload: Awaited<ReturnType<SessionGate["awaitStop"]>>) => StopClassification;
    workflowId?: string;
  }): Promise<DriveOutcome> {
    const runVerify = deps.runVerifyGates!;
    for (let rounds = 0; ; rounds += 1) {
      const verify = await runVerify(args.worktree);
      if (verify.ok) {
        console.error(`${args.tag} verify-on-stop: all gates pass — done stands`);
        return { kind: "done" };
      }
      if (rounds >= verifyRoundCap) {
        console.error(
          `${args.tag} verify-on-stop: still failing after ${verifyRoundCap} rounds — parking for a human`,
        );
        return { kind: "nudge-exhausted" };
      }
      console.error(
        `${args.tag} verify-on-stop: gates failed — nudge ${rounds + 1}/${verifyRoundCap}`,
      );
      await deps.tmux.sendText(
        args.sessionName,
        `The verification gates are failing — fix every failure below, then finish again. ` +
          `Do not mark the PR ready until they pass.\n\n${verify.report}`,
      );
      await deps.tmux.sendEnter(args.sessionName);
      const classification = await awaitNextStop({
        tag: args.tag,
        sessionName: args.sessionName,
        worktree: args.worktree,
        timeoutMs: nudgeStopTimeout,
        classifyAt: args.classifyAt,
        workflowId: args.workflowId,
      });
      // A re-stop means the agent "finished" its fix attempt — re-run the gates
      // (loop) rather than completing on the stale failure. A `done` loops
      // directly. A `bare-stop` is never completion on its own (#80): settle it
      // through the same readiness gate the initial stop used, so a re-classified
      // bare-stop can't bypass the done-signal — then loop to re-verify if it
      // cleared, else hand its parked outcome back. (No readiness seam → #80 is
      // off, but the gates still get the final word, so loop.)
      if (classification.kind === "done") continue;
      if (classification.kind === "bare-stop") {
        if (deps.epicPrReadiness) {
          const settled = await resolveBareStop({
            tag: args.tag,
            sessionName: args.sessionName,
            worktree: args.worktree,
            repo: args.repo,
            epicRef: args.epicRef,
            classifyAt: args.classifyAt,
            workflowId: args.workflowId,
          });
          if (settled.kind !== "done") return settled;
        }
        continue;
      }
      // Anything else (a question, a failure) flows back to the normal branch.
      return classification;
    }
  }

  async function prepareWorktree(ctx: StepContext<ImplementationInput>): Promise<PrepareResult> {
    createWorkflowRecord(deps.db, {
      id: ctx.executionId,
      kind: "implementation",
      repo: ctx.input.repo,
      epicRef: ctx.input.epicRef,
      adapter: ctx.input.adapter,
      source: ctx.input.source ?? "auto",
    });
    const resume = ctx.input.resume;
    if (resume) {
      // Continuation: reuse the prior round's worktree (same branch, same PR —
      // no new branch, no new PR) and re-prime the brief for this resume reason.
      const handle = resume.worktree;
      updateWorkflow(deps.db, ctx.executionId, { worktreePath: handle.path });
      writeResumeBrief(handle.path, ctx.input.epicRef, resume, reviewRoundCap);
      return { handle };
    }
    // NB: a *terminal* failure of this (first) step strands the row at `pending`
    // — the saga only compensates completed steps, so cleanupWorktree never runs
    // to mark it terminal. The daemon promotes that orphan to `failed` off
    // bunqueue's `workflow:failed` (retries-exhausted) signal — see
    // `promotePendingToFailed` in main.ts (issue #179). It is NOT done here: this
    // body re-runs on every retry attempt (default retry: 3), so flipping here
    // would mark a row `failed` that the very next attempt recovers (#108).
    const handle = await deps.worktree.createWorktree({
      repoPath: deps.resolveRepoPath(ctx.input.repo),
      repo: ctx.input.repo,
      epicRef: ctx.input.epicRef,
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
      // Build the default brief only when one isn't already present (a resume
      // wrote its own brief in prepare-worktree; an operator brief is preserved).
      // Resolving the per-repo ceiling / `approved` label touches `gh`, so it's
      // gated on that and made failure-safe — a flaky label read must fall back to
      // safe defaults, never fail the whole dispatch.
      // Resolve mode first — needed both for the dispatch brief and for mirroring
      // the mode-specific commands reference. Default to "github" on any error.
      let mode: "github" | "file" = "github";
      try {
        if (deps.resolveEpicStoreMode) {
          mode = await deps.resolveEpicStoreMode(ctx.input.repo);
        }
      } catch (error) {
        console.error(`${tag} mode-commands mirror skipped: ${(error as Error).message}`);
      }

      console.error(`${tag} ensuring .middle/prompt.md exists in worktree`);
      if (!existsSync(join(handle.path, ".middle", "prompt.md"))) {
        let complexityCeiling = DEFAULT_COMPLEXITY_CEILING;
        let approved = false;
        try {
          if (deps.resolveComplexityCeiling) {
            complexityCeiling = await deps.resolveComplexityCeiling(ctx.input.repo);
          }
          if (deps.isEpicApproved) {
            approved = await deps.isEpicApproved(ctx.input.repo, ctx.input.epicRef);
          }
        } catch (error) {
          console.error(
            `${tag} brief-context resolution failed, using defaults (ceiling=${DEFAULT_COMPLEXITY_CEILING}, approved=false): ${(error as Error).message}`,
          );
        }
        ensurePromptFile(handle.path, ctx.input.epicRef, complexityCeiling, approved, mode);
      }

      // Mirror the run's mode-specific commands reference into the worktree so the
      // implementer skill reads only the incantations for this Epic's store. Always
      // run (not gated on the prompt.md write above) and failure-safe.
      try {
        mirrorModeCommands(handle.path, mode);
      } catch (error) {
        console.error(`${tag} mode-commands mirror skipped: ${(error as Error).message}`);
      }

      console.error(`${tag} installing hooks in ${handle.path}`);
      await adapter.installHooks({
        worktree: handle.path,
        hookScriptPath: ".middle/hooks/hook.sh",
        dispatcherUrl: deps.dispatcherUrl,
        sessionName,
        sessionToken,
        epicRef: ctx.input.epicRef,
      });

      const { argv, env } = adapter.buildLaunchCommand({
        worktree: handle.path,
        sessionName,
        sessionToken,
        envOverrides: {
          MIDDLE_DISPATCHER_URL: deps.dispatcherUrl,
          MIDDLE_EPIC: String(ctx.input.epicRef),
        },
      });
      // Clear any orphaned session of the same name left by a prior dispatch
      // (or this workflow's own prior drive) before its cleanup ran — otherwise
      // newSession fails with "duplicate session". killSession is a no-op when
      // nothing's there.
      await deps.tmux.killSession(sessionName);
      console.error(`${tag} launching tmux session: ${argv.join(" ")} (cwd=${handle.path})`);
      await deps.tmux.newSession({ sessionName, command: argv, cwd: handle.path, env });

      // The first-prompt text is identical regardless of launch order; only
      // *when* it is sent relative to the SessionStart wait differs (below).
      const promptText = adapter.buildPromptText({
        promptFile: ".middle/prompt.md",
        kind: promptKind,
        epicRef: ctx.input.epicRef,
      });
      const sendPrompt = async (): Promise<void> => {
        console.error(`${tag} sending prompt (${promptKind}): "${promptText}"`);
        await deps.tmux.sendText(sessionName, promptText);
        await deps.tmux.sendEnter(sessionName);
      };

      // drive: SessionStart yields session_id + transcript_path. The launch
      // order forks on whether the CLI fires SessionStart at boot or only once
      // the first prompt is submitted (AgentAdapter.startsSessionOnFirstPrompt).
      let startPayload: HookPayload;
      if (adapter.startsSessionOnFirstPrompt) {
        // Prompt-triggered-session adapters (codex 0.133.0): the CLI creates no
        // session — and fires no SessionStart — until the first prompt arrives.
        // Dismiss the boot dialogs to completion FIRST (enterAutoMode resolves on
        // the composer-ready banner; the prompt must land at the input line, not a
        // dialog), THEN send the prompt, THEN await SessionStart. The hook server
        // stashes a SessionStart that arrives before we park on the gate, so the
        // prompt racing ahead of the await is race-safe (#183). enterAutoMode is
        // awaited (not fire-and-forget): a needs-login throw fails the launch fast
        // rather than feeding the prompt into a login screen.
        console.error(`${tag} prompt-first launch: dismissing boot dialogs before prompt`);
        await adapter.enterAutoMode({ sessionName });
        await sendPrompt();
        console.error(`${tag} waiting for SessionStart hook (timeout ${launchTimeout}ms)`);
        startPayload = await deps.sessionGate.awaitSessionStart(sessionName, launchTimeout);
      } else {
        // Boot-triggered-session adapters (claude): SessionStart fires at boot,
        // but only once the bypass-mode warning is dismissed. Run the dismisser in
        // *parallel* with the SessionStart wait — when it detects the prompt it
        // sends Down+Enter and Claude proceeds past the warning. Fire-and-forget
        // with .catch so a dismiss-side error never becomes an unhandled rejection.
        console.error(`${tag} starting bypass-prompt dismisser (parallel to SessionStart wait)`);
        const dismissPromise = adapter.enterAutoMode({ sessionName }).catch((err: unknown) => {
          console.error(`${tag} enterAutoMode failed: ${(err as Error).message}`);
        });
        console.error(`${tag} waiting for SessionStart hook (timeout ${launchTimeout}ms)`);
        startPayload = await deps.sessionGate.awaitSessionStart(sessionName, launchTimeout);
        void dismissPromise;
      }
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

      // Boot-triggered adapters send the prompt now — after SessionStart and the
      // running-state commit. Prompt-first adapters already sent it above.
      if (!adapter.startsSessionOnFirstPrompt) {
        await sendPrompt();
      }

      // observe: await the Stop boundary, liveness-aware — `awaitNextStop` parks
      // (not fails) when a hung/killed session left a blocked.json. The process
      // never exits between turns, so the Stop hook is the signal, not an exit.
      console.error(`${tag} waiting for Stop hook (timeout ${stopTimeout}ms)`);
      const classifyAt = (payload: HookPayload): StopClassification =>
        adapter.classifyStop({
          payload,
          transcriptPath,
          sentinelPresent: existsSync(join(handle.path, ".middle", "blocked.json")),
          worktree: handle.path,
        });
      const classification = await awaitNextStop({
        tag,
        sessionName,
        worktree: handle.path,
        timeoutMs: stopTimeout,
        classifyAt,
        workflowId: ctx.executionId,
      });
      console.error(`${tag} Stop received — classification=${classification.kind}`);
      // Positive done-signal (#80): a bare-stop is NOT completion on its own —
      // only a ready, non-draft Epic PR is. Otherwise nudge (session still
      // alive) up to maxNudges, then park. No readiness seam → legacy mapping.
      let outcome: DriveOutcome = classification;
      if (classification.kind === "bare-stop" && deps.epicPrReadiness) {
        outcome = await resolveBareStop({
          tag,
          sessionName,
          worktree: handle.path,
          repo: ctx.input.repo,
          epicRef: ctx.input.epicRef,
          classifyAt,
          workflowId: ctx.executionId,
        });
      }
      // Plan-comment guard (skill enforcement #1): a `done` only truly completes
      // if the agent posted its plan as an Epic comment. Demote an unposted
      // `done` to `failed` here so it never enters the review-resolve park.
      if (outcome.kind === "done" && deps.planCommentReader) {
        const planBody = readPlanBody(handle.path, ctx.input.epicRef);
        const guard = await verifyPlanComment({
          gh: deps.planCommentReader,
          repo: ctx.input.repo,
          epicRef: ctx.input.epicRef,
          planBody,
          agentLogin: deps.agentLogin,
        });
        if (!guard.ok) {
          console.error(`${tag} plan-comment guard: ${guard.reason}`);
          outcome = { kind: "failed", reason: guard.reason };
        }
      }
      // Verify-on-stop: a `done` only stands if the verify.toml gates pass. Runs
      // (and nudges to fix) while the session is still alive, BEFORE the agent
      // parks for review — so an unverified PR never goes up. Runs after the
      // plan-comment guard so a still-`done` outcome is the one that gets verified.
      if (outcome.kind === "done" && deps.runVerifyGates) {
        outcome = await enforceVerifyOnDone({
          tag,
          sessionName,
          worktree: handle.path,
          repo: ctx.input.repo,
          epicRef: ctx.input.epicRef,
          classifyAt,
          workflowId: ctx.executionId,
        });
      }
      // END SESSION — the turn is over; free the slot before parking/finalizing.
      await deps.tmux.killSession(sessionName);
      return { outcome, sessionName };
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
    const resume = ctx.input.resume;
    const promptKind = !resume
      ? "initial"
      : resume.reason === "answered-question"
        ? "answer"
        : "resume";
    return driveOnce(ctx, handle, promptKind);
  }

  /**
   * Park-worthy stop: arm the durable `waitfor_signals` row under the
   * epic-scoped, reason-scoped name the poller watches, set `waiting-human`,
   * and (for `asked-question`) post the question for human visibility. The
   * session already ended in `driveOnce`. The top-level `waitFor` that follows
   * then parks the execution because RESUME_EVENT is unset.
   */
  async function parkForResume(ctx: StepContext<ImplementationInput>): Promise<void> {
    const { outcome } = ctx.steps["launch-and-drive"] as DriveResult;
    const reason = reasonFor(outcome.kind);
    // Always arm the signal for the ACTUAL park reason — even if the watchdog's
    // sentinel fallback (`blocked:<id>`) is already armed from a stale
    // `.middle/blocked.json` written during an earlier phase. The two names map
    // to DIFFERENT resume reasons (`blocked:<id>` → `answered-question`,
    // `epic-N-review-resolved` → `review-changes`; see
    // `reasonFromSignalName`), so leaving review-resolved unarmed when the
    // agent's actual stop was `done` orphans the workflow: CR's review event
    // would never wake it because no review-resolved signal is armed. (Real
    // incident — PR #230 / Epic #208 sat parked ~11h with only `blocked:` armed
    // after CR posted CHANGES_REQUESTED.)
    //
    // `armWaitForSignal` is `INSERT OR IGNORE` keyed on `signal_name`, so
    // re-arming the same name is a no-op; arming a *different* name leaves both
    // wake paths live, which is correct when the workflow is genuinely waiting
    // on either a human answer or a CR re-review.
    armWaitForSignal(
      deps.db,
      signalNameFor(ctx.input.epicRef, reason),
      ctx.executionId,
      JSON.stringify({ reason }),
    );
    updateWorkflow(deps.db, ctx.executionId, { state: "waiting-human" });
    if (outcome.kind === "asked-question" && deps.postQuestion) {
      // The sentinel's `kind` distinguishes a complexity pause (surfaced under the
      // `complexity pause` state-issue label) from a plain question.
      const kind = outcome.sentinel?.kind === "complexity" ? "complexity" : "question";
      try {
        await deps.postQuestion({
          repo: ctx.input.repo,
          epicRef: ctx.input.epicRef,
          question: outcome.sentinel?.question ?? "(question text unavailable)",
          context: outcome.sentinel?.context,
          kind,
        });
      } catch (error) {
        // Visibility is best-effort — the wait is already armed and durable, so
        // a failed comment must not abort the park.
        console.error(`[workflow] postQuestion failed: ${(error as Error).message}`);
      }
    }
    // Consume the sentinel (#205, extended for the dual-signal bug): remove
    // `<worktree>/.middle/blocked.json` on EVERY park, not just `asked-question`.
    // On a `done`/review-changes park, a stale sentinel left from an earlier
    // phase would still cause the watchdog's rule-4 pass to re-arm `blocked:<id>`
    // on the next tick, racing the legitimate `epic-N-review-resolved` arm and
    // re-introducing the orphaned-resume class this fix closes.  Anchored on
    // the worktree handle (the stable home of the workstream's sentinels), not
    // the adapter-reported `sentinelPath`. The `waitFor` is already durably
    // armed, so removing the file can't strand the resume; unconditional
    // removal (even if `postQuestion` threw above) is also what stops the next
    // tick re-posting "(question text unavailable)".
    const { handle } = ctx.steps["prepare-worktree"] as PrepareResult;
    try {
      rmSync(join(handle.path, ".middle", "blocked.json"), { force: true });
    } catch (error) {
      console.error(`[workflow] sentinel cleanup failed: ${(error as Error).message}`);
    }
  }

  /**
   * Terminal stop: pre-seed RESUME_EVENT so the single top-level `waitFor`
   * falls through without parking. Rate-limit bookkeeping and the final
   * `workflows.state` are set in `resume-or-finalize` (alongside worktree
   * teardown), so all terminal handling lives in one place. `ctx.signals` is
   * the live `exec.signals` (passed by reference), which is exactly what the
   * downstream `waitFor` reads.
   */
  async function recordTerminal(ctx: StepContext<ImplementationInput>): Promise<void> {
    // Rate-limit bookkeeping lives solely in `finalize` (the authoritative terminal
    // handler), which always runs after this pre-seed falls the `waitFor` through.
    (ctx.signals as Record<string, unknown>)[RESUME_EVENT] = { terminal: true };
  }

  /**
   * Tear the worktree down and resolve the terminal `workflows.state` for a
   * settled classification. Called for genuinely-terminal stops and for a
   * review-resolved (`APPROVED` / clean re-review) `done`. middle never merges —
   * the human merges; this just records the terminal state and frees the worktree.
   */
  async function finalize(
    ctx: StepContext<ImplementationInput>,
    handle: WorktreeHandle,
    settled: DriveOutcome,
  ): Promise<void> {
    const finalState = finalStateFor(settled);
    // A `waiting-human` handoff (round cap exhausted, or nudge-exhausted mid-work)
    // keeps the worktree so the human can inspect / resume the in-progress state.
    // Every other terminal state frees it — the work is in the PR or abandoned.
    if (finalState !== "waiting-human") {
      await deps.worktree.destroyWorktree(handle);
    }
    if (settled.kind === "rate-limited") {
      setRateLimited(deps.db, {
        adapter: ctx.input.adapter,
        resetAt: parseResetAt(settled.resetAt),
        source: "transcript",
        detail: settled.resetAt,
      });
    } else if (finalState === "completed") {
      // Probe-via-real-work: a completed dispatch proves the adapter is serving
      // again, so a previously RATE_LIMITED adapter reverts to AVAILABLE.
      markAvailableOnSuccess(deps.db, ctx.input.adapter);
    }
    updateWorkflow(deps.db, ctx.executionId, { state: finalState });
  }

  /**
   * Reached after the `waitFor` resolves. Three outcomes:
   *
   *  - **Terminal stop** — `record-terminal` pre-seeded `{ terminal: true }`, so
   *    this drive's own classification is final; `finalize` ends it.
   *  - **Review resolved** — the poller fired `outcome: "resolved"` (`APPROVED`
   *    or a clean re-review). The loop ends (terminal); the human merges.
   *  - **A continuing resume** — an answered question, or a `CHANGES_REQUESTED`
   *    pass under the round cap. Hand off to a fresh continuation execution that
   *    reuses this worktree (re-primed per reason); this round ends `completed`
   *    and the continuation becomes the Epic's live (latest non-terminal) row.
   *
   * The review-round counter increments **per pass**. Once a `CHANGES_REQUESTED`
   * verdict would exceed `reviewRoundCap`, the workflow parks in `waiting-human`
   * with no re-arm and no continuation — a never-satisfied loop is bounded.
   */
  async function resumeOrFinalize(ctx: StepContext<ImplementationInput>): Promise<void> {
    const { handle } = ctx.steps["prepare-worktree"] as PrepareResult;
    const initial = ctx.steps["launch-and-drive"] as DriveResult;
    const signal = (ctx.signals as Record<string, unknown>)[RESUME_EVENT] as
      | { terminal?: boolean }
      | ResumeSignalPayload
      | undefined;

    // Terminal stop: the branch pre-seeded the signal; this drive is final.
    if (signal && (signal as { terminal?: boolean }).terminal) {
      await finalize(ctx, handle, initial.outcome);
      return;
    }

    // We genuinely parked, and the poller fired a resume verdict. Consume the
    // durable wait record so the workflow no longer reads as parked.
    const payload = signal as ResumeSignalPayload;
    consumeWaitForSignal(deps.db, ctx.executionId);

    // A resolved review (APPROVED, or a 0-actionable re-review) ends the loop.
    if (payload.reason === "review-changes" && payload.outcome === "resolved") {
      await finalize(ctx, handle, { kind: "done" });
      return;
    }

    // A continuing resume. Only a `CHANGES_REQUESTED` pass advances the review
    // counter; an answered question carries the round through unchanged.
    const currentRound = ctx.input.resume?.round ?? 0;
    let nextRound = currentRound;
    if (payload.reason === "review-changes") {
      nextRound = currentRound + 1;
      if (nextRound > reviewRoundCap) {
        // Bounded: stop auto-resuming and park for a human. Keep the worktree;
        // do not re-arm a wait (the poller stops watching) and do not re-enqueue.
        // Everything the agent has pushed stays on the branch / PR.
        updateWorkflow(deps.db, ctx.executionId, { state: "waiting-human" });
        return;
      }
    }

    // Hand control to a fresh continuation that reuses this worktree. Enqueue
    // FIRST: if it throws, neither the rate-limit state nor the row state has
    // changed, so the poller retries cleanly on its next pass.
    await deps.enqueueContinuation({
      repo: ctx.input.repo,
      epicRef: ctx.input.epicRef,
      adapter: ctx.input.adapter,
      source: ctx.input.source, // a continuation keeps the origin of its workstream
      resume: { reason: payload.reason, round: nextRound, worktree: handle, payload },
    });
    // The drive that just parked ran a working adapter; revert any stale
    // RATE_LIMITED now that the hand-off is committed.
    markAvailableOnSuccess(deps.db, ctx.input.adapter);
    // This round handed off — terminal in the bunqueue sense. The worktree is
    // NOT torn down; the continuation reuses it.
    updateWorkflow(deps.db, ctx.executionId, { state: "completed" });
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
        // Backstop above the internal waits, widened for every in-session nudge
        // wait both bounded loops can spend — including the verify loop's NESTED
        // bare-stop resolution (see `maxNudgeStopWaits`) — so it can't fire
        // mid-retry.
        timeout: launchTimeout + stopTimeout + maxNudgeStopWaits * nudgeStopTimeout + 60_000,
      })
      .branch((ctx) =>
        isParkKind((ctx.steps["launch-and-drive"] as DriveResult).outcome.kind)
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
