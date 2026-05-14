# Interactive tmux Dispatch — Design

**Date:** 2026-05-14
**Status:** Approved design — pending build-spec edits
**Supersedes:** the headless-`claude -p` dispatch model in `planning/middle-management-build-spec.md` (Adapter interface, Normalized event taxonomy, bunqueue workflows, Watchdog, Rate-limit detection, Build sequence Phases 1–2)

## Context

middle dispatches coding agents against GitHub Epics. The original build spec dispatches them **headlessly**: the adapter's `buildCommand()` returns a `claude -p --prompt-file …` argv, tmux runs it to completion, the process exits, and `classifyExit()` reads the exit code plus a captured stdout log to decide what happened.

`claude -p` can no longer be used to start a session. The headless path is gone. Agents must now run as **interactive CLI sessions inside tmux**, driven by `tmux send-keys`.

This is not a local patch — it changes how the dispatcher launches agents, how it observes them, how it knows they are ready, and how it ends and resumes their work. It ripples through six build-spec sections.

A second-order decision falls out of it: middle commits to **interactive-only dispatch for every adapter**, with no headless fallback. A headless code path is a vendor-removable rug — `claude -p` is the proof. Interactive + tmux + on-disk transcript is the durable substrate.

## Goals

- Dispatch and drive an interactive agent session entirely through tmux.
- Discover session readiness and the on-disk transcript location via hooks.
- Track agent activity and state from the on-disk transcript, not process stdio.
- Treat external validation (crons, durable workers) as the source of truth; hooks are the fast path.
- Make concurrency-slot usage reflect *active work*, not idle waiting.
- Define clear session boundaries and three cost-ordered continuation mechanisms.

## Non-goals

- A headless dispatch mode. Removed entirely; not reintroduced as a fallback.
- Multi-turn conversational driving of the agent. The dispatcher sends one prompt to start work; it does not converse turn-by-turn. (The bare-stop nudge is the one bounded exception.)
- Changing the Epic-granular dispatch model (one Epic = one branch = one PR = one workstream). Unchanged.
- `pr_mode = "stacked"`. Still reserved for the future.

## The model: launch → drive → observe

Every dispatch is three phases.

1. **Launch.** `tmux new-session -d` runs the CLI **interactively** — `claude` with no `-p` and no prompt. The CLI boots and waits for input. Workflow state: `launching`.
2. **Drive.** The `SessionStart` hook fires; the dispatcher learns the session is coming up, puts it into auto mode, confirms readiness from the transcript, then `send-keys` a one-line prompt pointer + `Enter`. This *starts the agent working*. Workflow state: `running`.
3. **Observe.** The agent works. The process **does not exit between turns**. The `Stop` hook marks each turn boundary; the dispatcher classifies the stop from the transcript + sentinel files + GitHub state. There is no exit code to read.

Interactive-only, all adapters: `ClaudeAdapter` and `CodexAdapter` both implement this model. There is no `dispatchMode` discriminant.

## Readiness and the launch sequence

The dispatcher must not `send-keys` before the CLI can accept input — keystrokes sent into a booting TUI are lost. Readiness is established by **hooks and the transcript coordinating**:

1. `tmux new-session -d` launches the interactive CLI. State → `launching`.
2. The **`SessionStart` hook** fires. Its payload carries `session_id` and `transcript_path`. The dispatcher records both on the workflow row. This is the hook's *discovery* job — it is how middle locates the on-disk transcript at all.
3. The dispatcher runs **`enterAutoMode`** (see Open questions): the interactive session must come up in auto mode (the old spec's `permission_mode = "auto"`), either via a launch flag or by sending `S-Tab S-Tab` keystrokes.
4. The dispatcher tails the **transcript** to confirm the session is genuinely live and idle-ready — the transcript confirms what the `SessionStart` hook only announces. `capture-pane` is retained only as a thin fallback if the transcript signal is ambiguous.
5. `send-keys` the prompt pointer, then `Enter`. State → `running`.

If `SessionStart` never arrives within a launch timeout, or the transcript never confirms readiness, the launch failed → kill the session → respawn (bounded retries).

### The prompt pointer

`send-keys` cannot cleanly carry a multi-line prompt — embedded newlines submit early. So the full prompt is written to `<worktree>/.middle/prompt.md` on disk (as the original spec already does), and `send-keys` carries only a **one-line pointer that force-includes the file**:

```
@.middle/prompt.md
```

A single `@` prefixes the whole relative path (not per path segment). The `@` is Claude Code's force-include syntax; it pulls the file into context. The adapter owns the exact framing text around the `@`-reference; the CLI launches with `cwd` = worktree so the relative path resolves.

## Transcript as the state channel

Interactive tmux gives no captured stdout stream, so the old `stream-json` log is gone. Its replacement is the CLI's **on-disk session transcript** (JSONL).

- The `SessionStart` hook payload yields `transcript_path`. The adapter's `resolveTranscriptPath()` abstracts this per-CLI (Claude provides it directly in the hook payload; Codex's location/format differs).
- `readTranscriptState()` reads the transcript for: last activity timestamp, turn boundaries, tool usage, **context/token usage**, and rate-limit messages.
- **Source of truth:** crons and durable workers that re-read the transcript + tmux state + GitHub state are authoritative. Hooks are the low-latency notification path but can be missed (network blip, the hook's 3 s timeout, misconfiguration). A reconciler cron corrects any drift between what hooks reported and what the transcript shows. Trust-but-verify, transcript authoritative.

This is structurally cleaner than parsing stdout: the transcript is complete, durable across dispatcher restarts, and already structured.

## Session lifecycle and boundaries

A live interactive session **holds a concurrency slot**. Parallelism is scoped on *active interactive sessions*. An agent sitting idle — blocked on a human, waiting on a rate-limit reset — is wasted capacity.

> **Principle: a session exists only while an agent is actively working. Any wait on something external ends the session and frees the slot. Resume is a fresh session.**

### State machine

```
[launching] ──launch timeout──▶ respawn (bounded)
   │ SessionStart hook → capture session_id + transcript_path
   ▼
[ready] ── enterAutoMode ── transcript confirms ──▶ send-keys "@.middle/prompt.md" + Enter
   ▼
[running] ◀── send-keys "continue" ──┐  ← only same-session continuation; preserves the
   │ Stop hook → classifyStop         │    session vs. a respawn. retry to a max, then kill.
   ├─ bare stop ──────────────────────┘
   ├─ asked-question ──▶ END SESSION (free slot) ▶ waiting-human ▶ resume (see below)
   ├─ done / PR ready ─▶ END SESSION (free slot) ▶ verification
   ├─ rate-limited ────▶ END SESSION (free slot) ▶ resume after reset
   ├─ context-overflow ▶ END SESSION (free slot) ▶ resume (fresh, always)
   └─ non-responsive ──▶ KILL SESSION ▶ resume (fresh, bounded)
```

Slots count sessions in `launching` / `ready` / `running`. `END SESSION` decrements the slot immediately — that is what lets the auto-dispatch loop launch the next agent.

`classifyStop()` replaces `classifyExit()`. Same classification variants (`done`, `asked-question`, `rate-limited`, `failed`, plus a new `bare-stop`), but driven by the `Stop` hook payload + transcript tail + `.middle/blocked.json` sentinel + PR state — never an exit code.

### Continuation mechanisms (cost-ordered)

When work resumes after a boundary, the workflow picks the cheapest mechanism that preserves *enough* state:

1. **send-keys into the live session** — free. Only available when no external wait occurred, i.e. the bare-stop nudge. The session is still alive; `send-keys "continue"`. Its value is **session preservation**: when the agent just stops for no clear reason, a cheap nudge is worth trying before paying the full cost of a new session. Scoped as a bounded retry — `send-keys "continue"` up to a max — and if the agent keeps bare-stopping, kill the session and fall through to a fresh respawn.
2. **Fresh session + reconstruction** — cheap. A brand-new session re-primed from the workstream's own artifacts: `@planning/issues/N/plan.md`, `@planning/issues/N/decisions.md`, and PR state. The **default** for resuming after any wait. The implementing-github-issues skill already writes these artifacts, so reconstruction is near-free.
3. **`claude --resume <session-id>`** — costs tokens; rehydrates the transcript into context. The **deliberate exception**, used only when in-flight reasoning is honestly worth the tokens and is not cheaply reconstructable from artifacts.

**Corollary: ending a tmux session frees the slot but does not burn the session.** `session_id` and `transcript_path` stay on the workflow row, and the transcript persists on disk. `--resume` remains available later — middle reclaims the slot *and* keeps the rehydration option.

Where `--resume` earns its tokens: verification "pump-to-finish" bounce-backs (a checkbox got reverted; the agent should fix the specific thing with full context) and quick-answered questions where the agent was mid-reasoning. Where it does not: context-overflow (rehydrating the bloat defeats the purpose — always fresh) and non-responsive recovery (the context may be the problem — always fresh).

Verification itself is **situational**, not a hard rule: default to fresh/clean context for the acceptance gate, but allow "resume-existing to pump it to finish" for quick bounce-backs. The workflow step picks.

## Adapter interface changes

```ts
export interface AgentAdapter {
  readonly name: string;

  /** Write hook config + per-CLI setup into the worktree. */
  installHooks(opts: InstallHookOpts): Promise<void>;

  /** Build the INTERACTIVE launch command. tmux runs this; it takes no prompt. */
  buildLaunchCommand(opts: LaunchOpts): { argv: string[]; env: Record<string, string> };

  /** The literal text to send-keys to start or continue the agent (incl. the @-reference). */
  buildPromptText(opts: { promptFile: string; kind: "initial" | "resume" | "answer" }): string;

  /** Put the ready session into auto mode — launch flag or post-ready keystrokes. */
  enterAutoMode(opts: { sessionName: string }): Promise<void>;

  /** The normalized hook event that signals the CLI is ready for input. */
  readonly readyEvent: NormalizedEvent;

  /** Locate the on-disk transcript from the session/ready hook payload. */
  resolveTranscriptPath(payload: HookPayload): string;

  /** Read activity, state, and context/token usage from the transcript. */
  readTranscriptState(transcriptPath: string): TranscriptState;

  /** Classify the agent's state at a Stop hook (replaces classifyExit). */
  classifyStop(opts: {
    payload: HookPayload;
    transcriptPath: string;
    sentinelPresent: boolean;
  }): StopClassification;

  /** Optional: detect a rate-limit message in a Stop-hook payload or transcript. */
  detectRateLimit?(opts: { payload: HookPayload; transcriptPath: string }): RateLimitDetection | null;
}
```

Mapping from the old interface:

| Old | New |
|---|---|
| `buildCommand` (headless argv) | `buildLaunchCommand` (interactive, no prompt) |
| — | `buildPromptText` (the send-keys text) |
| — | `enterAutoMode` |
| — | `readyEvent` |
| — | `resolveTranscriptPath` |
| — | `readTranscriptState` |
| `classifyExit` | `classifyStop` |
| `SpawnOpts` | `LaunchOpts` |
| `ExitClassification` | `StopClassification` (+ `bare-stop` variant) |

`TranscriptState` carries at least `{ lastActivity, contextTokens, turnCount, lastToolUse }`. The dispatcher's context monitor uses `contextTokens` to detect imminent overflow.

## Ripple: other build-spec sections

- **tmux helpers** — add `sendText(session, text)` (`tmux send-keys -l`, literal mode), `sendEnter(session)`, `capturePane(session)`. `newSession` now launches the interactive CLI; `hasSession` / `killSession` unchanged.
- **Normalized event taxonomy** — `session.started` is no longer purely observational: it *triggers a dispatcher action* (enter auto mode, confirm, send the prompt). `agent.stopped` (the `Stop` hook) becomes the turn boundary the workflow reacts to. Add explicit transcript-discovery fields (`session_id`, `transcript_path`) to the `session.started` payload contract.
- **Watchdog** — tmux liveness check unchanged. Heartbeat/transcript staleness becomes the *primary* stuck-agent detector, since the process never self-terminates. New failure modes: `stuck-launching` (no `readyEvent` within the launch timeout) and `prompt-not-accepted` (transcript never confirms the prompt landed).
- **Rate-limit detection** — the exit-code path is gone. Rate limits are detected from the `Stop` hook transcript / `detectRateLimit`. Still reactive.
- **bunqueue workflows** — the `implementation` workflow's `spawn-agent` step expands into `launch-cli → await-ready → enter-auto-mode → send-prompt → await-stop`. The `asked-question` path no longer re-spawns blindly: it ends the session, waits, then resumes via the cost-ordered mechanism. The `recommender` workflow's `spawn-recommender-agent` step likewise becomes an interactive launch (it is still a short one-shot — it just runs interactively now).
- **Build sequence** — the launch → readiness → send-keys loop is foundational; you cannot spawn an agent at all without it. It moves **into Phase 1**. Phase 1's acceptance ("agent runs, exits, workflow finalizes") is rewritten — there is no exit; the agent runs, hits `Stop`, the dispatcher classifies, and the session ends or is nudged. Phase 2's hooks shift from purely observational to *driving* dispatch, and gain the transcript-reconciler cron.

## Error handling and failure modes

| Failure | Detection | Response |
|---|---|---|
| CLI fails to boot | no `SessionStart` within launch timeout | kill session, respawn (bounded) |
| Prompt keystrokes lost | transcript never confirms prompt landed | re-send; then `prompt-not-accepted` → respawn (bounded) |
| Agent hangs mid-turn | transcript / heartbeat staleness (watchdog) | kill session, fresh resume (bounded) |
| Context near overflow | `readTranscriptState().contextTokens` over threshold | let current turn finish, end session, fresh resume |
| Adapter rate-limited | `detectRateLimit` on `Stop` | end session, resume after reset |
| Bare stop (no sentinel, not done) | `classifyStop` → `bare-stop` | `send-keys "continue"` retry (max N) to preserve the session; then kill + fresh respawn |
| Agent asks a question | `.middle/blocked.json` sentinel at `Stop` | end session, `waiting-human`, resume with the answer |

## Open / empirical questions

- **Auto-mode mechanism.** Unknown whether the interactive CLI honors a launch flag for permission mode, or whether `enterAutoMode` must `send-keys S-Tab S-Tab` in the TUI. Abstracted behind `AgentAdapter.enterAutoMode`; resolved empirically during implementation. The keystroke path is the guaranteed fallback. Not a design blocker.
- **Codex specifics.** `CodexAdapter` goes interactive too, but its `readyEvent`, launch command, transcript location/format, and auto-mode mechanism all differ from Claude's and need to be observed and filled in during the Codex phase.

## Testing approach

- **tmux helpers** — unit-test `sendText` / `sendEnter` / `capturePane` against a real throwaway tmux session.
- **Readiness sequence** — integration test: launch a real interactive CLI, assert `SessionStart` arrives, assert the transcript confirms readiness, assert the prompt lands (transcript shows the agent picked up `.middle/prompt.md`).
- **`classifyStop`** — unit-test each variant against recorded `Stop` payloads + transcript fixtures + sentinel-file states.
- **State machine** — test each boundary transition decrements the slot and selects the expected continuation mechanism.
- **Transcript reconciler cron** — test that it corrects a deliberately-stale DB row from the authoritative transcript.

## Out of scope

- Headless dispatch (removed, not reintroduced).
- Conversational multi-turn driving beyond the bounded bare-stop nudge.
- `pr_mode = "stacked"`.
- The auto-mode mechanism's empirical resolution (implementation-time, not design-time).
