# Wire Interactive tmux Dispatch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Propagate the approved interactive-tmux dispatch design into `planning/middle-management-build-spec.md` and the affected GitHub issues, so the build spec and the issue backlog both describe the interactive model instead of the dead `claude -p` headless model.

**Architecture:** Two parts. Part A edits the build spec section-by-section (one commit per section). Part B edits the affected GitHub issues (Phases 1, 2, 10, plus an audit of 5/7/8). The design is already captured and committed in `docs/superpowers/specs/2026-05-14-tmux-interactive-dispatch-design.md` — this plan transcribes it into the two planning artifacts.

**Tech Stack:** Markdown editing (`planning/middle-management-build-spec.md`), `gh` CLI for issue edits, `git` for commits.

---

## Working context

- **Branch:** `docs/interactive-tmux-dispatch` (already created, off `main`; the design doc is committed here).
- **Do not touch** the Epic #1 worktree / branch `worktree-1-bootstrap-repo-state-issue-parser` / PR #69 — unrelated.
- The build spec is one file: `planning/middle-management-build-spec.md`. Line numbers below are from the state at the start of this plan; **re-grep before each edit** since earlier edits shift line numbers.
- **GitHub API rate limit** may be exhausted at plan time. Before Part B, run `gh api rate_limit --jq .resources.core` and wait for reset if needed.

## Replacement vocabulary (used throughout)

When editing either artifact, this is the consistent old→new mapping:

| Old | New |
|---|---|
| `buildCommand` | `buildLaunchCommand` |
| `classifyExit` | `classifyStop` |
| `SpawnOpts` | `LaunchOpts` |
| `ExitClassification` | `StopClassification` |
| `claude -p …` headless invocation | interactive `claude` launch + `send-keys` prompt |
| "agent runs and exits" / "exit code" | "agent works, hits a `Stop`, dispatcher classifies" |
| "headless" (of agent processes) | "interactive (tmux + send-keys)" |
| log tail / stdout log | on-disk JSONL transcript |

---

## Part A — Wire the design into the build spec

### Task 1: Update Non-goals

**Files:**
- Modify: `planning/middle-management-build-spec.md` (Non-goals section, ~lines 26-33)

- [ ] **Step 1: Replace non-goal #3**

Find:
```
3. **Not a chat UI for agents.** Agents run headlessly in tmux. The dashboard is read-only on agent state.
```
Replace with:
```
3. **Not a chat UI for agents.** Agents run as interactive CLI sessions inside tmux, driven by the dispatcher via `tmux send-keys`. The dashboard is read-only on agent state.
```

- [ ] **Step 2: Add non-goal #7 after #6**

Find:
```
6. **No undocumented APIs for rate limits.** GitHub's `rate_limit` endpoint is fair game. For CLI subscriptions: reactive detection only (catch the error, extract the reset, wait).
```
Replace with:
```
6. **No undocumented APIs for rate limits.** GitHub's `rate_limit` endpoint is fair game. For CLI subscriptions: reactive detection only (catch the error, extract the reset, wait).
7. **No headless dispatch mode.** middle dispatches agents as interactive tmux sessions only. A headless CLI flag (`claude -p` and the like) is a vendor-removable rug — middle does not depend on one and keeps no headless fallback path.
```

- [ ] **Step 3: Verify**

Run: `grep -n "headlessly\|headless dispatch" planning/middle-management-build-spec.md`
Expected: one hit — the new non-goal #7. No "Agents run headlessly".

- [ ] **Step 4: Commit**

```bash
git add planning/middle-management-build-spec.md
git commit -m "spec: state interactive-only dispatch in Non-goals"
```

---

### Task 2: Rewrite the Adapter interface and adapter specifics

**Files:**
- Modify: `planning/middle-management-build-spec.md` (`## Adapter interface` through end of `### CodexAdapter specifics`, ~lines 690-759)

- [ ] **Step 1: Replace the entire `## Adapter interface` section**

Replace everything from the line `## Adapter interface` up to and including the last bullet of `### CodexAdapter specifics` (the line ending `…start with a generous \`/rate.?limit|429|too many requests/i\` and tighten.`) with:

````markdown
## Adapter interface

middle dispatches every agent as an **interactive CLI session inside tmux**. There is no headless mode. The adapter abstracts the per-CLI launch command, the prompt-delivery text, how to enter auto mode, how to locate and read the on-disk transcript, and how to classify a turn boundary.

```ts
// packages/core/src/adapter.ts

export interface AgentAdapter {
  readonly name: string;             // 'claude' | 'codex' | ...

  /** Write hook config + any per-CLI setup into the worktree. */
  installHooks(opts: InstallHookOpts): Promise<void>;

  /** Build the INTERACTIVE launch command. tmux runs this; it takes no prompt. */
  buildLaunchCommand(opts: LaunchOpts): {
    argv: string[];
    env: Record<string, string>;
  };

  /** The literal text to send-keys into the session to start or continue the
   *  agent — includes the `@`-reference to the on-disk prompt file. */
  buildPromptText(opts: {
    promptFile: string;              // path, relative to the worktree
    kind: 'initial' | 'resume' | 'answer';
  }): string;

  /** Put the ready session into auto mode — a launch flag or post-ready keystrokes. */
  enterAutoMode(opts: { sessionName: string }): Promise<void>;

  /** The normalized event that signals the CLI is ready for input. */
  readonly readyEvent: NormalizedEvent;

  /** Locate the on-disk session transcript from the ready/session hook payload. */
  resolveTranscriptPath(payload: HookPayload): string;

  /** Read activity, state, and context/token usage from the transcript. */
  readTranscriptState(transcriptPath: string): TranscriptState;

  /** Classify the agent's state at a Stop hook. */
  classifyStop(opts: {
    payload: HookPayload;
    transcriptPath: string;
    sentinelPresent: boolean;
  }): StopClassification;

  /** Optional: detect a rate-limit message in a Stop-hook payload or transcript. */
  detectRateLimit?(opts: {
    payload: HookPayload;
    transcriptPath: string;
  }): RateLimitDetection | null;
}

export type InstallHookOpts = {
  worktree: string;
  hookScriptPath: string;       // .middle/hooks/hook.sh in the worktree
  dispatcherUrl: string;        // http://127.0.0.1:8822
  sessionName: string;
  sessionToken: string;         // HMAC token for hook auth
  epicNumber: number;           // the Epic (or standalone issue) being dispatched
};

export type LaunchOpts = {
  worktree: string;
  sessionName: string;
  sessionToken: string;
  envOverrides?: Record<string, string>;
};

export type TranscriptState = {
  lastActivity: string;         // ISO
  contextTokens: number;        // for the context-overflow monitor
  turnCount: number;
  lastToolUse: string | null;
};

export type StopClassification =
  | { kind: 'done' }                                   // agent marked the PR ready
  | { kind: 'asked-question'; sentinelPath: string }
  | { kind: 'rate-limited'; resetAt: string /* ISO */ }
  | { kind: 'bare-stop' }                              // stopped, no sentinel, not done
  | { kind: 'failed'; reason: string };

export type RateLimitDetection = {
  resetAt: string;
  source: 'stop-hook' | 'transcript';
};
```

### `ClaudeAdapter` specifics

- `buildLaunchCommand`: `["claude"]` — interactive, no `-p`, no prompt. Env (`MIDDLE_*`) injected by tmux at spawn time.
- `buildPromptText`: returns a one-line `@`-reference that force-includes the on-disk prompt — `@.middle/prompt.md` (a single `@` prefixing the whole relative path). `kind: 'resume'` points additionally at `@planning/issues/<n>/plan.md` and `@.../decisions.md`; `kind: 'answer'` frames the human's reply.
- `enterAutoMode`: brings the session up in auto mode (the old `permission_mode = "auto"`). Mechanism is empirical — a launch flag if one is honored in interactive mode, otherwise `tmux send-keys S-Tab S-Tab`. The keystroke path is the guaranteed fallback.
- `readyEvent`: `session.started` (from the `SessionStart` hook).
- `resolveTranscriptPath`: reads `transcript_path` directly from the `SessionStart` hook payload.
- `readTranscriptState`: parses the JSONL transcript for last activity, turn count, last tool use, and cumulative context tokens.
- `classifyStop`: checks `<worktree>/.middle/blocked.json` for the question sentinel; matches the transcript tail against `/You've hit your usage limit\. Resets at (.+?)\./` for rate limits; reads PR state for `done`; otherwise `bare-stop`. Auto-mode termination after 3 consecutive denials → `failed` with the message reason.
- `detectRateLimit`: same usage-limit regex applied to the `Stop` hook transcript text.

### `CodexAdapter` specifics

- `buildLaunchCommand`: the interactive `codex` invocation (no `exec`). `approval_policy = "never"` and `sandbox = "workspace-write"` live in `.codex/config.toml`, not the command line.
- `buildPromptText`: Codex's force-include syntax for the on-disk prompt file (observed during the Codex phase).
- `enterAutoMode`, `readyEvent`, `resolveTranscriptPath`, `readTranscriptState`: Codex's launch flag / keystrokes, ready hook, and transcript location/format differ from Claude's and are filled in during Phase 10.
- `classifyStop`: matches Codex's rate-limit message (start with a generous `/rate.?limit|429|too many requests/i` and tighten as patterns are observed).
````

- [ ] **Step 2: Verify**

Run: `grep -n "buildCommand\|classifyExit\|SpawnOpts\|ExitClassification\|claude.*-p.*--permission-mode\|--prompt-file" planning/middle-management-build-spec.md`
Expected: zero hits in the Adapter interface / ClaudeAdapter / CodexAdapter region (lines may still appear elsewhere — those are handled by later tasks).

- [ ] **Step 3: Commit**

```bash
git add planning/middle-management-build-spec.md
git commit -m "spec: rewrite Adapter interface for interactive dispatch"
```

---

### Task 3: Update the Normalized event taxonomy

**Files:**
- Modify: `planning/middle-management-build-spec.md` (`## Normalized event taxonomy`, ~lines 763-796)

- [ ] **Step 1: Replace the intro line and add the load-bearing-events paragraph**

Find:
```
All adapters emit these. The hook script POSTs `{type, sessionName, payload}` to the dispatcher.
```
Replace with:
```
All adapters emit these. The hook script POSTs `{type, sessionName, payload}` to the dispatcher. Hooks are the **fast-path notification**; the authoritative state is the on-disk transcript, reconciled by a cron (see "Dispatch lifecycle").
```

Then find the line immediately after the event table (the line `The hook script is uniform across both:`) and insert **before** it:
```
Two events are **load-bearing for dispatch**, not merely observational:

- `session.started` carries `session_id` and `transcript_path` in its payload. It is how the dispatcher discovers the on-disk transcript at all, and it triggers the launch→drive transition (enter auto mode, confirm readiness, send the prompt).
- `agent.stopped` is the turn boundary the workflow reacts to. Because the interactive process does not exit between turns, this — not a process exit — is the signal the dispatcher classifies (`classifyStop`).

```

(The event table itself and the `hook.sh` block are unchanged.)

- [ ] **Step 2: Verify**

Run: `grep -n "load-bearing for dispatch\|fast-path notification" planning/middle-management-build-spec.md`
Expected: two hits, both in the Normalized event taxonomy section.

- [ ] **Step 3: Commit**

```bash
git add planning/middle-management-build-spec.md
git commit -m "spec: mark session.started and agent.stopped as dispatch-driving"
```

---

### Task 4: Add transcript columns and the launching state to the SQLite schema

**Files:**
- Modify: `planning/middle-management-build-spec.md` (`## SQLite schema`, `workflows` table, ~lines 807-828)

- [ ] **Step 1: Add `'launching'` to the workflows `state` CHECK constraint**

Find:
```
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'running', 'waiting-human', 'rate-limited',
    'completed', 'compensated', 'failed', 'cancelled'
  )),
```
Replace with:
```
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'launching', 'running', 'waiting-human', 'rate-limited',
    'completed', 'compensated', 'failed', 'cancelled'
  )),
```

- [ ] **Step 2: Add `session_id` and `transcript_path` columns**

Find:
```
  session_name TEXT,
  session_token TEXT,
```
Replace with:
```
  session_name TEXT,
  session_token TEXT,
  session_id TEXT,              -- the CLI's own session id, from the SessionStart hook
  transcript_path TEXT,         -- on-disk JSONL transcript; retained after the tmux session ends so --resume stays available
```

- [ ] **Step 3: Verify**

Run: `grep -n "session_id\|transcript_path\|'launching'" planning/middle-management-build-spec.md`
Expected: three hits in the `workflows` table definition.

- [ ] **Step 4: Commit**

```bash
git add planning/middle-management-build-spec.md
git commit -m "spec: add session_id, transcript_path, launching state to workflows table"
```

---

### Task 5: Insert the new "Dispatch lifecycle" section

**Files:**
- Modify: `planning/middle-management-build-spec.md` (insert a new section immediately before `## bunqueue workflows`, ~line 883)

- [ ] **Step 1: Insert the new section**

Find the line `## bunqueue workflows` and insert **before** it:

````markdown
## Dispatch lifecycle

Every dispatch is **launch → drive → observe**. There is no headless mode and no exit code to read.

1. **Launch.** `tmux new-session -d` runs the interactive CLI (`claude`, no prompt). Workflow state: `launching`.
2. **Drive.** The `SessionStart` hook fires — its payload yields `session_id` and `transcript_path`, recorded on the workflow row. The dispatcher runs `enterAutoMode`, tails the transcript to confirm the session is live and idle-ready (`capture-pane` is a thin fallback), then `send-keys` the adapter's prompt text (`@.middle/prompt.md`) followed by `Enter`. Workflow state: `running`.
3. **Observe.** The agent works; the process does not exit between turns. Each `Stop` hook is a turn boundary; the dispatcher runs `classifyStop` against the transcript + `.middle/blocked.json` sentinel + PR state.

### Transcript as the state channel

Interactive tmux gives no captured stdout. The CLI's on-disk JSONL **transcript** replaces it: `readTranscriptState` reads activity, turn boundaries, tool use, and context/token usage. Hooks are the fast-path notification; **crons and durable workers reconciling against the transcript are the source of truth** — a reconciler cron corrects any drift between what hooks reported and what the transcript shows.

### Sessions are slot-expensive

A live interactive session holds a concurrency slot; parallelism is scoped on active interactive sessions. So:

> **A session exists only while an agent is actively working. Any wait on something external — a human, a rate-limit reset — ends the session and frees the slot. Resume is a fresh session.**

```
[launching] ──launch timeout──▶ respawn (bounded)
   │ SessionStart hook → capture session_id + transcript_path
   ▼
[ready] ── enterAutoMode ── transcript confirms ──▶ send-keys "@.middle/prompt.md" + Enter
   ▼
[running] ◀── send-keys "continue" ──┐  ← only same-session continuation; preserves the
   │ Stop hook → classifyStop         │    session vs. a respawn. retry to a max, then kill.
   ├─ bare stop ──────────────────────┘
   ├─ asked-question ──▶ END SESSION (free slot) ▶ waiting-human ▶ resume
   ├─ done / PR ready ─▶ END SESSION (free slot) ▶ verification
   ├─ rate-limited ────▶ END SESSION (free slot) ▶ resume after reset
   ├─ context-overflow ▶ END SESSION (free slot) ▶ resume (fresh, always)
   └─ non-responsive ──▶ KILL SESSION ▶ resume (fresh, bounded)
```

Slots count sessions in `launching` / `ready` / `running`. `END SESSION` decrements the slot immediately — that is what lets the auto-dispatch loop launch the next agent.

### Continuation mechanisms (cost-ordered)

Ending a tmux session frees the slot but does **not** burn the session: `session_id` and `transcript_path` stay on the workflow row, so `--resume` remains available. Resuming work picks the cheapest mechanism that preserves enough state:

1. **send-keys into the live session** — free. Only when no external wait occurred (the bare-stop nudge). Its value is session preservation: a cheap nudge before paying for a new session. Bounded retry, then kill + fresh respawn.
2. **Fresh session + reconstruction** — cheap. A new session re-primed from the workstream's own artifacts (`@planning/issues/<n>/plan.md`, `@.../decisions.md`, PR state). The default for resuming after any wait.
3. **`<cli> --resume <session-id>`** — costs tokens; rehydrates the transcript into context. The deliberate exception — used only when in-flight reasoning is honestly worth the tokens (verification "pump-to-finish" bounce-backs; quick-answered questions mid-reasoning). Never for context-overflow (rehydrates the bloat) or non-responsive recovery (the context may be the problem) — those always go fresh.

The empirical unknown — whether `enterAutoMode` uses a launch flag or `S-Tab S-Tab` keystrokes — is abstracted behind the adapter and resolved during implementation; the keystroke path is the guaranteed fallback.

Full design rationale: `docs/superpowers/specs/2026-05-14-tmux-interactive-dispatch-design.md`.

---
````

- [ ] **Step 2: Verify**

Run: `grep -n "## Dispatch lifecycle\|## bunqueue workflows" planning/middle-management-build-spec.md`
Expected: `## Dispatch lifecycle` appears immediately before `## bunqueue workflows`.

- [ ] **Step 3: Commit**

```bash
git add planning/middle-management-build-spec.md
git commit -m "spec: add Dispatch lifecycle section (launch/drive/observe + session boundaries)"
```

---

### Task 6: Update the bunqueue workflows section

**Files:**
- Modify: `planning/middle-management-build-spec.md` (`## bunqueue workflows`, ~lines 883-951)

- [ ] **Step 1: Update the `resume-with-answer` comment in the implementation workflow**

Find:
```
      .step('resume-with-answer', resumeAgent)   // re-spawn; agent continues from the paused sub-issue
```
Replace with:
```
      .step('resume-with-answer', resumeAgent)   // fresh session re-primed from plan.md/decisions.md/PR, or --resume when in-flight context is worth the tokens (see "Dispatch lifecycle")
```

- [ ] **Step 2: Update the implementation-workflow prose paragraph**

Find:
```
Each step is small, well-named, and individually testable. Compensations roll back PR changes (close draft, label `agent-blocked`), worktree cleanup, and session kill. The `asked-question` path covers both an ambiguous sub-issue and a `complexity pause` — the agent pauses at the current sub-issue, the Epic's other completed sub-issues stay done on the branch, and a human reply resumes the same workstream.
```
Replace with:
```
Each step is small, well-named, and individually testable. The agent-spawning steps (`plan`, `implement-loop`) follow the launch → drive → observe model from "Dispatch lifecycle" — launch the interactive CLI, await readiness, `enterAutoMode`, `send-keys` the prompt, then react to `Stop` via `classifyStop`. Compensations roll back PR changes (close draft, label `agent-blocked`), worktree cleanup, and session kill. The `asked-question` path covers both an ambiguous sub-issue and a `complexity pause`: the agent pauses at the current sub-issue, the session **ends to free its slot**, the Epic's completed sub-issues stay done on the branch, and a human reply resumes the workstream as a fresh session (or `--resume`, per "Dispatch lifecycle").
```

- [ ] **Step 3: Update the recommender-workflow prose**

Find:
```
Recommender uses its own dedicated slot (not counted against `maxConcurrent`).
```
Replace with:
```
The `spawn-recommender-agent` step is an interactive launch like any other (the recommender is still a short one-shot — it just runs interactively now). Recommender uses its own dedicated slot (not counted against `maxConcurrent`).
```

- [ ] **Step 4: Verify**

Run: `grep -n "re-spawn\|launch → drive → observe\|interactive launch like any other" planning/middle-management-build-spec.md`
Expected: no "re-spawn" in the workflows section; the two new phrases present.

- [ ] **Step 5: Commit**

```bash
git add planning/middle-management-build-spec.md
git commit -m "spec: align bunqueue workflows with interactive dispatch lifecycle"
```

---

### Task 7: Rewrite the Watchdog section

**Files:**
- Modify: `planning/middle-management-build-spec.md` (`## Watchdog`, ~lines 981-996)

- [ ] **Step 1: Replace the entire `## Watchdog` section**

Replace everything from `## Watchdog` up to and including the line `The watchdog NEVER overrides "in progress" decisions made by hooks. Hooks update heartbeat first; watchdog only acts on staleness.` with:

````markdown
## Watchdog

Bunqueue cron, runs every 30 seconds, reconciles per `launching` and `running` workflow:

1. **Launch timeout** — a `launching` workflow whose `readyEvent` has not arrived within the launch timeout, or whose transcript never confirmed the prompt landed, is marked `failed` (reason `stuck-launching` or `prompt-not-accepted`). bunqueue retry decides whether to re-launch.

2. **tmux liveness** — `tmux has-session -t <name>` and pane count. A dead session whose workflow is `running` → mark `failed` with reason `tmux session disappeared`. Trigger compensation.

3. **Activity freshness** — `now - last_heartbeat`, cross-checked against transcript staleness (the interactive process never self-terminates, so staleness is the primary stuck-agent detector):
   - < `IDLE_THRESHOLD` (default 5 min): healthy
   - ≥ `IDLE_THRESHOLD`, < `IDLE_KILL_THRESHOLD` (default 15 min): mark `idle` in events; dashboard shows yellow
   - ≥ `IDLE_KILL_THRESHOLD`: `tmux kill-session`, mark workflow `failed` with reason `idle-timeout`. Resume is a fresh session.

4. **Sentinel files** — `<worktree>/.middle/blocked.json` exists but no `waitFor` signal armed for this workflow → re-arm the signal (handles a race where the agent wrote the sentinel after the workflow advanced).

A companion **reconciler cron** re-reads each `running` workflow's transcript and corrects any drift between what hooks reported and what the transcript shows — the transcript is the source of truth, hooks are the fast path.

The watchdog NEVER overrides "in progress" decisions made by hooks. Hooks and the transcript update activity first; the watchdog only acts on staleness.
````

- [ ] **Step 2: Verify**

Run: `grep -n "stuck-launching\|prompt-not-accepted\|reconciler cron\|transcript staleness" planning/middle-management-build-spec.md`
Expected: all four phrases present in the Watchdog section.

- [ ] **Step 3: Commit**

```bash
git add planning/middle-management-build-spec.md
git commit -m "spec: add launch-timeout, transcript staleness, reconciler to Watchdog"
```

---

### Task 8: Update the Rate-limit detection section

**Files:**
- Modify: `planning/middle-management-build-spec.md` (`## Rate-limit detection`, ~lines 998-1004)

- [ ] **Step 1: Replace the "Two sources" intro and both numbered items**

Find:
```
Two sources, both reactive:

1. **Exit classifier** — adapter's `classifyExit` matches the log tail. On match, returns `{kind: 'rate-limited', resetAt}`. The workflow transitions to `rate-limited`; bunqueue re-enqueues with `delay: resetAt - now`.

2. **Stop-hook detector** — adapter's `detectRateLimit` runs against every Stop hook payload. If matched, fires a `rate-limit.detected` synthetic event with `resetAt`. The dispatcher updates `rate_limit_state` immediately even though the agent technically exited 0.
```
Replace with:
```
Two sources, both reactive, both at the `Stop` boundary (there is no process exit to classify):

1. **Stop classifier** — adapter's `classifyStop` matches the transcript tail. On match, returns `{kind: 'rate-limited', resetAt}`. The workflow ends the session, transitions to `rate-limited`, and bunqueue re-enqueues with `delay: resetAt - now`.

2. **Stop-hook detector** — adapter's `detectRateLimit` runs against every `Stop` hook payload + transcript. If matched, fires a `rate-limit.detected` synthetic event with `resetAt`; the dispatcher updates `rate_limit_state` immediately.
```

- [ ] **Step 2: Verify**

Run: `grep -n "classifyExit\|Exit classifier" planning/middle-management-build-spec.md`
Expected: zero hits in the Rate-limit detection section (one may remain at the Phase 5 build-sequence reference — handled in Task 9).

- [ ] **Step 3: Commit**

```bash
git add planning/middle-management-build-spec.md
git commit -m "spec: rebase Rate-limit detection on the Stop boundary"
```

---

### Task 9: Update the Build sequence (Phases 1, 2, 5)

**Files:**
- Modify: `planning/middle-management-build-spec.md` (`### Phase 1 — Minimal dispatcher`, `### Phase 2 — Hooks + watchdog`, and the Phase 5 item referencing `classifyExit`, ~lines 1173-1219)

This task encodes one deliberate sequencing decision: **Phase 1 keeps a minimal `SessionStart`-only hook receiver.** The interactive model cannot function without it — `SessionStart` is how readiness is signalled and how the transcript is discovered. The full hook taxonomy, events table, watchdog, and reconciler stay in Phase 2. (Alternative considered: Phase 1 uses `capture-pane` polling for readiness with no hooks at all — rejected because transcript discovery genuinely needs the hook payload, and `capture-pane` would be thrown away one phase later.)

- [ ] **Step 1: Replace Phase 1**

Find the `### Phase 1 — Minimal dispatcher` block (items 5-11 and its `**Acceptance:**` line) and replace it with:
```
### Phase 1 — Minimal dispatcher

5. SQLite migrations + db wrapper.
6. Config loader (global + per-repo, TOML).
7. `AgentAdapter` interface + `ClaudeAdapter` (only): `buildLaunchCommand`, `buildPromptText`, `enterAutoMode`, `classifyStop`, `resolveTranscriptPath`, `readTranscriptState`. Full `installHooks` is Phase 2 — Phase 1 ships a minimal `SessionStart`-only receiver (next item).
8. tmux helpers: `newSession` (interactive launch), `sendText` (`send-keys -l`), `sendEnter`, `capturePane`, `hasSession`, `killSession`, `status`.
9. Worktree helpers (create, destroy, list).
10. Minimal `SessionStart` hook receiver — enough to capture `session_id` + `transcript_path` and signal readiness. (Full taxonomy + HMAC + events table is Phase 2.)
11. One bunqueue workflow: `implementation` with just 3 steps (worktree-prepare → launch-and-drive → cleanup). `launch-and-drive` runs the launch → drive → observe loop; no skill enforcement yet.
12. `mm start`, `mm stop`, `mm status` CLI commands.

**Acceptance:** `mm dispatch <test-repo> <epic>` launches Claude as an interactive tmux session; the dispatcher discovers the transcript via `SessionStart`, enters auto mode, `send-keys` the prompt; the agent works and hits a `Stop`; `classifyStop` runs; the workflow finalizes and the worktree is cleaned up.
```

- [ ] **Step 2: Replace Phase 2**

Find the `### Phase 2 — Hooks + watchdog` block (items 12-17 and its `**Acceptance:**` line) and replace it with:
```
### Phase 2 — Hooks + watchdog

13. Full hook server (Bun.serve, `/hooks/:event` endpoint with HMAC validation) — expands the Phase 1 minimal receiver to the whole taxonomy.
14. `installHooks` for ClaudeAdapter writes `.claude/settings.json` for the full event set.
15. Universal `hook.sh` curl script.
16. Events table populated from incoming hooks. Activity tracked from `tool.pre`/`tool.post` and cross-checked against transcript staleness.
17. Transcript reconciler cron — re-reads each `running` workflow's transcript, corrects drift; the transcript is the source of truth.
18. Watchdog cron: launch-timeout + tmux liveness + activity freshness + sentinel check.
19. Reactive rate-limit detection in `classifyStop` and `detectRateLimit`.

**Acceptance:** Spawn an agent, watch hook events flow into SQLite and the transcript reconciler keep state honest. Kill the tmux session; watchdog catches it within 30s. Force a rate-limit message; the dispatcher records `reset_at` correctly.
```

- [ ] **Step 3: Fix the Phase 5 `classifyExit` reference**

Find (in `### Phase 5 — Human-in-loop`):
```
27. Sentinel-file detection in `classifyExit`.
```
Replace with:
```
27. Sentinel-file detection in `classifyStop`.
```

- [ ] **Step 4: Verify**

Run: `grep -n "classifyExit\|buildCommand\|headless\|agent runs, exits\|spawns Claude in tmux" planning/middle-management-build-spec.md`
Expected: zero hits across the whole file.

- [ ] **Step 5: Commit**

```bash
git add planning/middle-management-build-spec.md
git commit -m "spec: rewrite Build sequence Phases 1-2 for interactive dispatch"
```

---

## Part B — Update affected GitHub issues

> Before starting Part B: `gh api rate_limit --jq .resources.core` — if `remaining` is low, wait for `reset`. Each issue edit fetches the body, swaps the specified blocks, and writes it back with `gh issue edit <n> --body-file <tmpfile>` (and `--title` where noted). Preserve every part of the body not called out below (Context, Out of scope, References).

### Task 10: Update Phase 1 issues

**Issues:** #6, #7, #9, #10, #12

- [ ] **Step 1: #6 — Epic acceptance**

`gh issue edit 6`: in **Acceptance criteria**, replace
`- [ ] \`mm dispatch <test-repo> <issue>\` spawns Claude in a tmux session, the agent runs and exits, the workflow finalizes, and the worktree is cleaned up`
with
`- [ ] \`mm dispatch <test-repo> <epic>\` launches Claude as an interactive tmux session; the dispatcher discovers the transcript via the \`SessionStart\` hook, enters auto mode, and \`send-keys\` the prompt; the agent works, hits a \`Stop\`, \`classifyStop\` runs, the workflow finalizes, and the worktree is cleaned up`

- [ ] **Step 2: #7 — SQLite columns**

`gh issue edit 7`: in **Acceptance criteria**, replace the `001_initial.sql` line with:
`- [ ] \`001_initial.sql\` creates all tables from the spec's "SQLite schema": \`workflows\` (including \`session_id\`, \`transcript_path\`, and \`'launching'\` in the \`state\` CHECK set), \`events\`, \`rate_limit_state\`, \`repo_config\`, \`waitfor_signals\`, \`schema_version\`, with the documented indexes and CHECK constraints`

- [ ] **Step 3: #9 — AgentAdapter + ClaudeAdapter**

`gh issue edit 9 --title "Define AgentAdapter interface and ClaudeAdapter (launch + classify)"`. Replace the **Context** sentence "At this phase the adapter only spawns and classifies — hook installation lands in Phase 2." with "At this phase the adapter launches the interactive CLI and classifies `Stop` boundaries; full hook installation lands in Phase 2." Replace the **Acceptance criteria** block with:
```
- [ ] `packages/core/src/adapter.ts` defines `AgentAdapter` with `name`, `installHooks`, `buildLaunchCommand`, `buildPromptText`, `enterAutoMode`, `readyEvent`, `resolveTranscriptPath`, `readTranscriptState`, `classifyStop`, and optional `detectRateLimit`, plus the supporting types (`InstallHookOpts`, `LaunchOpts`, `TranscriptState`, `StopClassification`, `RateLimitDetection`) from the spec's "Adapter interface"
- [ ] `packages/adapters/claude/` implements `AgentAdapter`
- [ ] `buildLaunchCommand` produces the interactive Claude launch from the spec's "ClaudeAdapter specifics" (`["claude"]` — no `-p`, no prompt; `MIDDLE_*` env injected by tmux)
- [ ] `buildPromptText` returns the `@`-reference one-liner (`@.middle/prompt.md`) for `kind: 'initial'`, and the reconstruction / answer variants for `'resume'` / `'answer'`
- [ ] `enterAutoMode` brings the session up in auto mode (launch flag if honored in interactive mode, else `tmux send-keys S-Tab S-Tab` — keystroke path is the guaranteed fallback)
- [ ] `classifyStop` returns `done` / `asked-question` / `rate-limited` / `bare-stop` / `failed`, including the usage-limit regex match against the transcript tail for `rate-limited`
- [ ] `resolveTranscriptPath` reads `transcript_path` from the `SessionStart` hook payload; `readTranscriptState` parses the JSONL transcript for activity, turn count, last tool use, and context tokens
- [ ] `installHooks` may be a minimal `SessionStart`-only stub at this phase (full implementation is Phase 2) — interface present, launch + classify functional
- [ ] Tests cover `buildLaunchCommand` argv/env, `buildPromptText` output, and each `classifyStop` branch against sample transcript tails + sentinel states
```
Replace the **Out of scope** first bullet "Real `installHooks` writing `.claude/settings.json` (Phase 2, task 13)" with "Full `installHooks` writing the whole `.claude/settings.json` event set (Phase 2)". Update the **References** "ClaudeAdapter specifics" line to also mention "Dispatch lifecycle".

- [ ] **Step 4: #10 — tmux helpers**

`gh issue edit 10 --title "Implement tmux session helpers (launch, send-keys, capture-pane, has-session, kill, status)"`. In **Context**, replace "agents run headlessly inside tmux sessions" with "agents run as interactive sessions inside tmux, driven by send-keys". Replace the **Acceptance criteria** block with:
```
- [ ] `packages/dispatcher/src/tmux.ts` exposes launch, send-text, send-enter, capture-pane, has-session, kill, and status helpers
- [ ] `newSession` creates a detached session (`tmux new-session -d`) running a given command, with env injected via `tmux new-session -e KEY=val`
- [ ] `sendText` sends literal text into a session (`tmux send-keys -l`, so prompt content is not interpreted as key names); `sendEnter` sends `Enter`
- [ ] `capturePane` returns the pane contents (`tmux capture-pane -p`) for readiness / echo confirmation
- [ ] `hasSession` reports whether a named session is alive; `status` reports pane count / liveness; `killSession` terminates a named session
- [ ] Helpers shell out to the `tmux` binary and surface failures as typed errors, not silent no-ops
- [ ] Tests cover the lifecycle (launch → has-session true → send-text → capture-pane shows it → kill → has-session false), skipped gracefully if `tmux` is unavailable
```

- [ ] **Step 5: #12 — 3-step implementation workflow**

`gh issue edit 12`. In **Acceptance criteria**, replace the three steps line and the spawn-agent line:
- replace `- [ ] \`packages/dispatcher/src/workflows/implementation.ts\` defines a \`bunqueue/workflow\` \`Workflow\` with exactly three steps: prepare-worktree → spawn-agent → cleanup`
  with `- [ ] \`packages/dispatcher/src/workflows/implementation.ts\` defines a \`bunqueue/workflow\` \`Workflow\` with exactly three steps: prepare-worktree → launch-and-drive → cleanup`
- replace `- [ ] spawn-agent uses the adapter's \`buildCommand\` and the tmux helpers to run the agent`
  with `- [ ] launch-and-drive runs the launch → drive → observe loop: \`buildLaunchCommand\` + tmux launch, await readiness via the minimal \`SessionStart\` receiver, \`enterAutoMode\`, \`send-keys\` the \`buildPromptText\` prompt, then react to the \`Stop\` boundary via \`classifyStop\``
- replace `- [ ] A \`workflows\` row is created (with \`epic_number\`) and transitions through \`pending\` → \`running\` → \`completed\` (or \`compensated\`/\`failed\`)`
  with `- [ ] A \`workflows\` row is created (with \`epic_number\`) and transitions through \`pending\` → \`launching\` → \`running\` → \`completed\` (or \`compensated\`/\`failed\`)`

- [ ] **Step 6: Verify**

Run: `for n in 6 7 9 10 12; do echo "#$n:"; gh issue view $n --json title,body --jq '.title, (.body | test("buildCommand|classifyExit|headless|spawns Claude|runs and exits") | if . then "STALE REF FOUND" else "clean" end)'; done`
Expected: every issue prints `clean`.

---

### Task 11: Update Phase 2 issues

**Issues:** #14, #15, #16, #18, #19, #20

- [ ] **Step 1: #14 — Epic**

`gh issue edit 14`. In **Context**, replace "Hooks observe; workflows decide." with "Hooks discover and drive (readiness, transcript location, turn boundaries); the on-disk transcript is the state channel; crons reconcile against it as the source of truth." In **Acceptance criteria**, replace `- [ ] Spawning an agent flows hook events into SQLite` with `- [ ] Spawning an agent flows hook events into SQLite; \`session.started\` records \`session_id\` + \`transcript_path\`; the reconciler cron keeps state honest against the transcript`.

- [ ] **Step 2: #15 — hook server**

`gh issue edit 15`. In **Acceptance criteria**, add after the `:event` line:
`- [ ] On \`session.started\`, the handler records \`session_id\` + \`transcript_path\` onto the workflow row and signals launch readiness (the launch → drive transition); other events are persisted as in task 15`

- [ ] **Step 3: #16 — installHooks**

`gh issue edit 16`. In **Acceptance criteria**, add after the event-entries line:
`- [ ] The \`SessionStart\` and \`Stop\` entries are load-bearing for dispatch — \`SessionStart\` carries \`session_id\`/\`transcript_path\`, \`Stop\` is the turn boundary the workflow classifies (not a process exit)`

- [ ] **Step 4: #18 — events table + heartbeats**

`gh issue edit 18`. In **Acceptance criteria**:
- replace `- [ ] \`tool.pre\` and \`tool.post\` events update \`workflows.last_heartbeat\` for the originating workflow`
  with `- [ ] \`tool.pre\`/\`tool.post\` events update \`workflows.last_heartbeat\`; \`session.started\` writes \`session_id\` + \`transcript_path\` onto the workflow row`
- add: `- [ ] activity freshness is cross-checked against transcript staleness (the interactive process never self-exits)`

- [ ] **Step 5: #19 — watchdog**

`gh issue edit 19`. In **Acceptance criteria**:
- add as the first criterion: `- [ ] launch-timeout: a \`launching\` workflow with no \`readyEvent\` within the timeout, or whose transcript never confirmed the prompt landed, is marked \`failed\` (\`stuck-launching\` / \`prompt-not-accepted\`)`
- replace the heartbeat-freshness criterion's parenthetical to note it is cross-checked against transcript staleness
- add: `- [ ] a companion reconciler cron re-reads each \`running\` workflow's transcript and corrects drift`

- [ ] **Step 6: #20 — classifyStop rate-limit**

`gh issue edit 20 --title "Add reactive rate-limit detection in classifyStop"`. In **Context**, replace "the exit-classifier path" with "the Stop-classifier path". Replace the **Acceptance criteria** block with:
```
- [ ] `ClaudeAdapter.classifyStop` matches the usage-limit message in the transcript tail and returns `{ kind: 'rate-limited', resetAt }`
- [ ] On that classification the workflow ends the session, transitions to `rate-limited`, and is re-enqueued with `delay: resetAt - now`
- [ ] `rate_limit_state` for the adapter is set to `{ status: 'RATE_LIMITED', reset_at, source: 'transcript' }`
- [ ] When `reset_at` passes, the adapter reverts to `AVAILABLE` after the next successful dispatch (probe-via-real-work)
- [ ] Tests cover a rate-limited transcript tail → classification → `rate_limit_state` update
```
In **Out of scope**, replace "The Stop-hook `detectRateLimit` path (can be a follow-up; this task is the `classifyExit` path)" with "Deep tuning of `detectRateLimit` against varied Stop payloads (this task is the `classifyStop` transcript path)".

- [ ] **Step 7: Verify**

Run: `for n in 14 15 16 18 19 20; do echo "#$n:"; gh issue view $n --json title,body --jq '.title, (.body | test("classifyExit|buildCommand|exited 0|Hooks observe") | if . then "STALE REF FOUND" else "clean" end)'; done`
Expected: every issue prints `clean`.

---

### Task 12: Update Phase 10 issues

**Issues:** #60, #61

- [ ] **Step 1: #60 — Epic**

`gh issue edit 60`. In **Acceptance criteria**, replace `- [ ] The same issue dispatched once per adapter on a test repo produces conforming output for both` with `- [ ] The same issue dispatched once per adapter on a test repo — both as interactive tmux sessions — produces conforming output for both`.

- [ ] **Step 2: #61 — CodexAdapter**

`gh issue edit 61`. Replace the **Acceptance criteria** block with:
```
- [ ] `packages/adapters/codex/` implements `AgentAdapter`
- [ ] `buildLaunchCommand` produces the interactive Codex launch from the spec's "CodexAdapter specifics" (interactive `codex`, no `exec`; `approval_policy = "never"` and `sandbox` live in `.codex/config.toml`, not the command line)
- [ ] `buildPromptText` uses Codex's force-include syntax for the on-disk prompt file
- [ ] `enterAutoMode`, `readyEvent`, `resolveTranscriptPath`, `readTranscriptState` are implemented for Codex (its launch flag/keystrokes, ready hook, and transcript location/format differ from Claude's — observe and fill in here)
- [ ] `installHooks` writes `<worktree>/.codex/config.toml` with a `[hooks]` block, mapping Codex's hook event names to the normalized event taxonomy
- [ ] `classifyStop` matches Codex's rate-limit signals (starting with a generous `/rate.?limit|429|too many requests/i`, to be tightened as patterns are observed)
- [ ] Tests cover `buildLaunchCommand`, `buildPromptText`, `installHooks` output shape, and `classifyStop` branches
```

- [ ] **Step 3: Verify**

Run: `for n in 60 61; do echo "#$n:"; gh issue view $n --json body --jq '(.body | test("buildCommand|classifyExit|codex exec") | if . then "STALE REF FOUND" else "clean" end)'; done`
Expected: both print `clean`.

---

### Task 13: Audit Phases 5, 7, 8 issues for stale references

The design's ripple list named the `recommender` workflow (Phase 7) and the human-in-loop / sentinel path (Phase 5). Their issues may carry headless-model vocabulary.

- [ ] **Step 1: Scan**

Run:
```bash
for p in 5 7 8; do
  for n in $(gh issue list --label "phase:$p" --state all --json number --jq '.[].number'); do
    if gh issue view $n --json body --jq '.body' | grep -qE 'buildCommand|classifyExit|SpawnOpts|ExitClassification|headless|claude -p|--prompt-file|runs and exits|exit code'; then
      echo "#$n HAS STALE REFS"
    fi
  done
done
```

- [ ] **Step 2: Fix each flagged issue**

For every issue printed by Step 1, `gh issue edit <n>` applying the **Replacement vocabulary** table at the top of this plan: `buildCommand`→`buildLaunchCommand`, `classifyExit`→`classifyStop`, `SpawnOpts`→`LaunchOpts`, `ExitClassification`→`StopClassification`, "headless"→"interactive", "runs and exits"→"works and hits a `Stop`", and any `claude -p …`/`--prompt-file` invocation → the interactive launch + `send-keys` prompt. Preserve all other body content.

- [ ] **Step 3: Verify**

Re-run Step 1's scan. Expected: no output (no `HAS STALE REFS` lines).

---

## Task 14: Final audit and open the PR

**Files:**
- Read: `planning/middle-management-build-spec.md`

- [ ] **Step 1: Full spec audit**

Run: `grep -nE 'claude -p|buildCommand|classifyExit|SpawnOpts|ExitClassification|--prompt-file|headlessly|stream-json|agent runs, exits' planning/middle-management-build-spec.md`
Expected: zero hits.

- [ ] **Step 2: Confirm spec ↔ design-doc consistency**

Read `docs/superpowers/specs/2026-05-14-tmux-interactive-dispatch-design.md` and skim the edited build-spec sections. Confirm the `AgentAdapter` interface, the state machine, the continuation mechanisms, and the event taxonomy match between the two documents.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin docs/interactive-tmux-dispatch
gh pr create --title "docs: interactive tmux dispatch — design + build-spec wiring" --body "$(cat <<'EOF'
## Summary
`claude -p` can no longer start a session. This replaces middle's headless dispatch model with interactive CLI sessions driven by `tmux send-keys`.

- Adds the design doc: `docs/superpowers/specs/2026-05-14-tmux-interactive-dispatch-design.md`
- Wires it into `planning/middle-management-build-spec.md`: Non-goals, Adapter interface, Normalized event taxonomy, SQLite schema, a new Dispatch lifecycle section, bunqueue workflows, Watchdog, Rate-limit detection, Build sequence Phases 1-2/5
- Affected GitHub issues updated in place: Phase 1 (#6 #7 #9 #10 #12), Phase 2 (#14 #15 #16 #18 #19 #20), Phase 10 (#60 #61), plus a stale-reference audit of Phases 5/7/8

## Key decisions
- Interactive-only, all adapters — no headless fallback path
- On-disk transcript replaces the stdio log as the state channel; crons reconcile as source of truth
- Sessions are slot-expensive: any external wait ends the session and frees the slot
- Three cost-ordered continuation mechanisms; ending a session retains `session_id` for optional `--resume`
- Phase 1 keeps a minimal `SessionStart`-only hook receiver (the interactive model can't function without it)

## Verification
- `grep` audit: no `claude -p` / `buildCommand` / `classifyExit` / headless references remain in the build spec
- All listed issues re-scanned clean of stale headless-model vocabulary
EOF
)"
```

- [ ] **Step 4: Report the PR URL**

---

## Self-Review

**Spec coverage** — every section in the design doc maps to a task:
- Context / Non-goals / durability rationale → Task 1
- Adapter interface + ClaudeAdapter + CodexAdapter specifics → Task 2
- Normalized event taxonomy changes → Task 3
- SQLite `session_id`/`transcript_path`/`launching` → Task 4
- launch→drive→observe, transcript-as-state-channel, slot principle, state machine, continuation mechanisms → Task 5
- bunqueue workflow ripple → Task 6
- Watchdog ripple (stuck-launching, prompt-not-accepted, transcript staleness, reconciler) → Task 7
- Rate-limit detection ripple → Task 8
- Build sequence ripple → Task 9
- Affected issues → Tasks 10-13
- Consistency audit + PR → Task 14

**Placeholder scan** — no TBD/TODO; the one empirical unknown (auto-mode mechanism) is carried as explicit spec text with a stated fallback, not a plan placeholder. The Phase 5/7/8 audit (Task 13) is a concrete scan-and-replace with a fixed vocabulary, not a vague "handle edge cases".

**Type consistency** — `buildLaunchCommand`, `buildPromptText`, `enterAutoMode`, `readyEvent`, `resolveTranscriptPath`, `readTranscriptState`, `classifyStop`, `LaunchOpts`, `TranscriptState`, `StopClassification`, `RateLimitDetection` are used identically in Task 2 (spec), Task 9 (build sequence), and Tasks 10-12 (issues). The `bare-stop` variant and `source: 'transcript'` are consistent across Tasks 2, 8, 11.
