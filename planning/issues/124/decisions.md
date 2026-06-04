# Decisions — Issue #124 (CopilotAdapter)

## Grounded the adapter in a live probe, not the build spec
**File(s):** `packages/adapters/copilot/*`
**Date:** 2026-06-03

**Decision:** The `copilot` binary (GitHub Copilot CLI 1.0.54) is installed and
authed in this environment, so before writing a line of adapter code I ran a
live probe: a throwaway `COPILOT_HOME` + git worktree, a heartbeat hook config
that POSTs every event to a local receiver, launched `copilot` in tmux, sent one
tiny prompt, and recorded the firing order, payloads, transcript location, and
tool names. The adapter is coded against that captured ground truth.

**Why:** This is the Codex runner lesson applied with the one advantage Codex
lacked. The Codex phase had no `codex` binary in the sandbox, so every empirical
bit (event names, transcript format, rate-limit shape) was coded from the spec
and marked a "tightening point" (`planning/issues/60/decisions.md`). Copilot is
the *second data point* the Epic wants — and because the binary is present, I can
make those bits *facts* instead of guesses. "Iteration > theory": the probe is
10 minutes that removes the entire tightening-point backlog the Codex adapter
carried.

**Evidence:** Probe output recorded in this file's sibling sections below;
re-runnable via `packages/adapters/copilot/scripts/verify-live-hooks.ts`.

## Codex runner lessons reused (the #125 criterion)
**File(s):** `packages/adapters/copilot/*`
**Date:** 2026-06-03

**Decision:** Reused, not re-derived:
- **`COPILOT_HOME` repoint** mirrors Codex's `CODEX_HOME` — point all CLI state
  at `<worktree>/.copilot` so the worktree-local config + hooks load.
- **`startsSessionOnFirstPrompt: true`** — the Codex lesson that a non-Claude CLI
  may fire no `SessionStart` until the first prompt; the dispatcher's prompt-first
  launch order (#183) already handles it. The probe confirmed Copilot is exactly
  this case.
- **`enterAutoMode` returns on a composer-ready pane probe** (not the boot
  deadline) so the prompt-first send isn't stalled — same shape as Codex's
  `detectReadyForInput`.
- **PR-ready gate as a second `preToolUse` matcher group** scoped to the shell
  tool, riding alongside the universal heartbeat — identical to Codex/Claude.
- **`classifyStop` sentinel logic is adapter-agnostic** — the
  `.middle/{blocked,done,failed}.json` files are written by the universal skill;
  Copilot reuses the exact resolution, only the rate-limit read differs.
- **Hook script single-sourced** from `@middle/core` (`HOOK_SH`/`PR_READY_GATE_SH`)
  verbatim, through `sh "<abs>" <event>`.

**Copilot-specific divergence (where Codex's lessons did NOT carry):**
- **No auth symlink.** Codex needed `auth.json` symlinked into the repointed home;
  Copilot authenticates via `gh` (`~/.config/gh`, unaffected by `COPILOT_HOME`),
  so the worktree home needs no auth file. Simpler seam.
- **camelCase, string-encoded payloads.** Codex's hooks mirror Claude's snake_case
  (`tool_input.command`); Copilot uses `toolName`/`toolArgs` (a JSON *string*).
- **No `transcript_path` in the payload** — derived (below).
- **No per-turn `Stop` hook** — the load-bearing strain (below).

## `sessionEnd → agent.stopped`: Copilot's turn boundary (the documented seam strain)
**File(s):** `packages/adapters/copilot/src/hooks.ts`
**Date:** 2026-06-03

**Decision:** Map Copilot's `sessionEnd` to the normalized `agent.stopped`. Copilot
emits **no per-turn stop hook** — its events are `sessionStart`, `userPromptSubmitted`,
`preToolUse`, `postToolUse`, `sessionEnd`, `errorOccurred`. `sessionEnd` (probe:
`reason:"user_exit"` on `/exit`) is the only session/turn boundary signal, and it
fires when the process exits.

**Why this mapping is required, not merely chosen:** the implementation drive's
done-detection only runs through `agent.stopped` → `classifyStop` →
(`done`/`asked-question`/`failed`/`bare-stop`→PR-readiness). The `awaitStopOrSessionEnd`
session-ended path (tmux liveness) classifies *only* the blocked/park case (a
`blocked.json` present); with no sentinel it throws (failure). So an adapter that
never emits `agent.stopped` can never report `done`. Mapping `sessionEnd→agent.stopped`
makes the existing drive work unchanged.

**The seam this strains (the #124 headline finding):** Claude and Codex fire a
turn-boundary hook while the process **stays alive** (nudgeable). Copilot's only
boundary signal coincides with **process exit** (not nudgeable). The autonomous
dispatch model fits this — the agent runs one continuous arc and ends at a
terminal state (PR-ready / blocked / failed). The known edge: a true `bare-stop`
(agent exited, no ready PR, no sentinel) would have `resolveBareStop` try to nudge
a dead session; that send fails and the drive fails — which is the correct outcome
for an agent that exited without finishing. No `AgentAdapter` interface change was
needed; the strain is in the *turn-boundary semantics*, documented for #127.

## `resolveTranscriptPath` derives the path (no `transcript_path` in the payload)
**File(s):** `packages/adapters/copilot/src/transcript.ts`
**Date:** 2026-06-03

**Decision:** Copilot's `sessionStart` payload carries `sessionId` + `cwd` but no
transcript path (Claude/Codex both hand one over). Derive it:
`<cwd>/.copilot/session-state/<sessionId>/events.jsonl`. `cwd` at `sessionStart`
(source `new`) is the launch cwd = the worktree, and `COPILOT_HOME` =
`<worktree>/.copilot` by our `buildLaunchCommand`, so the join is exact. Throw if
`sessionId` is absent (fail fast at launch→drive, like Codex).

**Why:** Keeps the empirical difference behind `resolveTranscriptPath` exactly as
the interface intends — the dispatcher still gets one path and never learns
Copilot lacks a native one.

## `readTranscriptState` parses `events.jsonl`; contextTokens is best-effort
**File(s):** `packages/adapters/copilot/src/transcript.ts`
**Date:** 2026-06-03

**Decision:** Parse the typed `events.jsonl`: `timestamp` (ISO) → `lastActivity`;
`assistant.turn_end` count → `turnCount`; last `tool.execution_start`'s
`data.toolName` → `lastToolUse`. `contextTokens` is best-effort: Copilot's
transcript exposes per-message `outputTokens` but no cumulative *input/context*
fill (that lives only in the OTEL `gen_ai.client.token.usage` metric), and Copilot
manages its own context via checkpoints. We sum nothing misleading — `contextTokens`
tracks the last assistant message's `outputTokens` as a coarse monotone proxy and
is documented as degraded; the watchdog's load-bearing signals (`lastActivity`,
`lastToolUse`) are exact.

**Why:** The watchdog needs activity/tool freshness (exact here); the
context-overflow monitor is explicitly a fast-path estimate with the reconciler as
authoritative, and Copilot self-manages context — so a precise input-token read
isn't worth coupling `readTranscriptState` to the OTEL file.

## PR-ready gate `extractCommand` must read Copilot's `toolArgs` (a real leak fixed)
**File(s):** `packages/dispatcher/src/gates/pr-ready.ts`
**Date:** 2026-06-03

**Decision:** `extractCommand` read only `payload.tool_input.command` (Claude/Codex
snake_case object). Copilot's `preToolUse` payload is `{toolName:"bash",
toolArgs:"{\"command\":\"...\"}"}` — `toolArgs` a JSON *string*. Without handling
it, `extractCommand` returns null for Copilot, `commandIsPrReady` never matches,
and the PR-ready gate **silently never fires** for a Copilot session. Extended
`extractCommand` to also parse `toolArgs`/`tool_args` (string→JSON→`.command`).

**Why:** This is a genuine abstraction leak in the gate's blast radius — the gate
is adapter-agnostic in intent but Claude-shaped in code. Fixed in-pass with a test;
the matcher difference (`bash` lowercase for Copilot vs `Bash`) is handled in the
copilot adapter's hook registration.

## State-issue rate-limit pair stays `{claude, codex}` (deliberate, schema-bound)
**File(s):** `packages/state-issue/src/parser.ts`, `packages/dispatcher/src/workflows/recommender.ts`
**Date:** 2026-06-03

**Decision:** Do NOT add copilot to the state issue's Rate-limits section. Those
two lines are fixed by `schemas/state-issue.v1.md` to exactly claude + codex —
the same deliberate, documented exception the Codex phase recorded
(`planning/issues/60/decisions.md` → "#63 abstraction-leak audit"). Generalizing
to N adapters is a schema (v2) change, out of this Epic's scope.

**Why:** The criterion is "fixed, or documented as a deliberate exception." This is
schema-bound, not an abstraction leak; left as-is by design, consistent with the
precedent.

## Self-review hardening: validate the derived-path sessionId
**File(s):** `packages/adapters/copilot/src/transcript.ts`
**Date:** 2026-06-03

**Decision:** `resolveTranscriptPath` now rejects a `sessionId` that isn't a plain
identifier (`/^[A-Za-z0-9_-]+$/`) before joining it into the path. Claude/Codex
read a `transcript_path` handed over wholesale; Copilot is the only adapter that
*joins an untrusted-shaped payload field into a filesystem path*, so a crafted
`sessionId` (`../…`, `a/b`) would otherwise escape `<cwd>/.copilot/session-state/`.

**Why:** Surfaced by the internal clean-eyes review pass (Phase 10b) — the class is
"path component from a payload." The payload comes from the trusted `copilot`
binary today, but the derivation shouldn't be the weak link if that changes.
Covered by a `test.each` of escape attempts.
