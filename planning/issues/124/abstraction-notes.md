# Abstraction notes — does `AgentAdapter` generalize to a third CLI? (#127)

The headline: **the `AgentAdapter` interface did not change to add Copilot.** No
member was added, removed, or re-typed (`git diff packages/core/src/adapter.ts`
touches only comments, if anything). Copilot is a structurally *different* CLI
from both Claude and Codex — different hook event names, different payload casing
and encoding, a different transcript store, a different auth model, and (the big
one) no per-turn stop hook — and all of it fit behind the existing methods.
`describe.each(knownAdapters())` in `adapter-conformance.test.ts` picked the new
adapter up from a one-line registry change and the same call sequence passed.

## Seams that held cleanly

- **`buildLaunchCommand` / auto mode.** Copilot's `--allow-all-tools` (+
  `COPILOT_ALLOW_ALL`) is a launch flag, like Claude's `--dangerously-skip-permissions`
  and unlike Codex's config-file policy — and the method abstracts exactly that.
- **`COPILOT_HOME` repoint.** The Codex `CODEX_HOME` lesson transferred verbatim:
  point all CLI state at `<worktree>/.copilot` so worktree-local config + hooks load.
- **`startsSessionOnFirstPrompt`.** The flag added *for Codex* (#183) fit Copilot
  with zero change — Copilot is the second CLI that fires no `sessionStart` until
  the first prompt, validating that the flag (not a hardcode) was the right shape.
- **Sentinel classification.** `.middle/{blocked,done,failed}.json` resolution is
  adapter-agnostic; the conformance suite asserts identical behavior across all three.
- **The PR-ready gate's exit-code contract.** Copilot's `preToolUse` is fail-closed
  (exit≠0 denies the tool) — which is *exactly* the gate's `exit 2` blocks contract.
  The shared `PR_READY_GATE_SH` works unmodified.

## Seams that strained (documented, no interface change)

1. **No per-turn stop hook — the load-bearing strain.** Claude and Codex fire a
   turn-boundary hook *while the process stays alive* (so the dispatcher can nudge
   a bare-stop). Copilot's only session/turn boundary is `sessionEnd`, which fires
   on **process exit**. We map `sessionEnd → agent.stopped` because the
   implementation drive's done-detection only runs through `agent.stopped`. It works
   for the autonomous single-arc dispatch model (the agent ends at a terminal state),
   but the *semantics* differ: a Copilot `agent.stopped` means "session gone", not
   "stopped but nudgeable". **If a 4th adapter shared this shape, the cheap
   improvement would be a `stopMeansExit?: boolean` adapter flag** so the drive skips
   the nudge path for exit-only adapters — but one data point didn't justify adding it.

2. **Transcript path is derived, not delivered.** Claude/Codex hand over
   `transcript_path`; Copilot's payload has only `sessionId` + `cwd`, so
   `resolveTranscriptPath` *derives* `<cwd>/.copilot/session-state/<sessionId>/events.jsonl`.
   The method's signature already allowed this — it just had only ever been a lookup
   before. Held behind the interface.

3. **Payload casing + encoding.** Copilot payloads are camelCase (`sessionId`,
   `toolName`) and `toolArgs` is a JSON *string*. This leaked into ONE shared place
   the interface doesn't cover — the PR-ready gate's `extractCommand`, which read
   only Claude/Codex's `tool_input.command`. Fixed in-pass (it now parses `toolArgs`);
   a genuine, if small, abstraction leak the third adapter surfaced.

4. **Context tokens.** Copilot exposes per-message `outputTokens` but no cumulative
   input/context fill on disk (only the OTEL metric), and self-manages context via
   checkpoints. `readTranscriptState.contextTokens` is best-effort for Copilot; the
   load-bearing watchdog signals (`lastActivity`, `lastToolUse`) are exact.

## Would a 4th adapter be cheap?

Yes for anything Claude/Codex-shaped. The one place to watch is the turn-boundary:
a 4th CLI with no per-turn stop would make the `sessionEnd→agent.stopped` /
exit-only pattern a *second* data point, which is the threshold at which the
`stopMeansExit?` flag above becomes worth adding to the interface. Until then the
abstraction holds without modification — the third adapter's verdict.

## Live tri-dispatch (the Epic's headline criterion)

`mm dispatch <test-repo-issue> --adapter {claude,codex,copilot}`, each an interactive
tmux session, is the operator/post-merge step (the running daemon executes `main`,
which lacks this branch's copilot registry; restarting it would abort the dispatch
that produced this PR — the same constraint the Codex phase recorded). It is
**mechanically pre-proven** here: `packages/adapters/copilot/scripts/verify-live-hooks.ts`
drives the *real* `copilot` binary end-to-end through the real adapter code and
observed the full heartbeat (`session.started`, `turn.started`, `tool.pre`,
`tool.post`, `agent.stopped`), a prompt-triggered session, and a real derived
`events.jsonl` — the live evidence the Codex phase could not produce (no `codex`
binary in its sandbox).
