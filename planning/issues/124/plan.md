# Issue #124: CopilotAdapter

**Link:** https://github.com/thejustinwalsh/middle/issues/124
**Branch:** middle-issue-124

## Goal
Ship the **third** `AgentAdapter` — GitHub Copilot CLI — alongside Claude and Codex, proving the abstraction generalizes past a second CLI. One branch / one PR, worked through the three sub-issue phases continuously.

## Approach
- **Mirror the CodexAdapter** package shape (`index.ts`/`hooks.ts`/`prompt.ts`/`classify.ts`/`transcript.ts` + a `scripts/verify-live-hooks.ts`), reusing every runner lesson Codex surfaced rather than re-deriving them (#125 criterion).
- **Ground the adapter in live observation, not the spec.** Unlike the Codex phase (the `codex` binary was absent in the sandbox, so everything was a "tightening point"), the `copilot` binary **is installed and authed here**. A live probe captured the real hook firing order, payload shapes, transcript location, and tool names — the adapter is coded against that ground truth.
- Isolate the per-CLI differences behind the existing interface; document any seam the third adapter strains (#127), changing `AgentAdapter` only if forced (and re-validating Claude+Codex if so).

### Ground truth from the live probe (copilot 1.0.54)
- **Hooks**: `~/.copilot/hooks/*.json` schema `{version:1, hooks:{event:[{type:"command",command,matcher,timeoutSec}]}}`. `COPILOT_HOME` repoints all state (like `CODEX_HOME`). Hooks inherit the tmux session env (so `MIDDLE_*` reach `hook.sh`).
- **Events** (camelCase): `sessionStart`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, `sessionEnd`, `errorOccurred`. **No per-turn `Stop` event.**
- **Order**: `userPromptSubmitted` → `sessionStart` (`source:"new"`, carries `initialPrompt`) → tool hooks → `sessionEnd` (only on exit). So `sessionStart` fires **after the first prompt** → `startsSessionOnFirstPrompt: true` (like Codex).
- **Payloads** are camelCase: `sessionId`, `timestamp` (Unix ms number), `cwd`, `toolName`, `toolArgs` (a JSON **string**), `toolResult:{resultType,textResultForLlm}`, `reason`. **No `transcript_path`.**
- **Shell tool name** is `bash` (matcher for the PR-ready gate). `preToolUse` is **fail-closed** (exit≠0 denies the tool) — perfect for the gate, requires the heartbeat to exit 0.
- **Transcript**: `$COPILOT_HOME/session-state/<sessionId>/events.jsonl` — typed events with ISO `timestamp`, `assistant.turn_end`, `tool.execution_start` (`data.toolName`), `assistant.message` (`outputTokens`). Derived from `sessionId`+`cwd`, since no path is in the payload.
- **Auth** flows from `gh` (`~/.config/gh`), not a file in `COPILOT_HOME` — so **no auth symlink** (cleaner than Codex).

## Phases (= open sub-issues)
1. **#125 Implement the CopilotAdapter** — the `packages/adapters/copilot` package, all interface methods, unit tests against probe fixtures, `verify-live-hooks.ts`.
2. **#126 Per-CLI adapter selection** — register `copilotAdapter`; add copilot to config defaults; copilot `buildPromptText`; fix the PR-ready gate's `extractCommand` to read Copilot's `toolArgs` (else the gate silently never fires for copilot); tests.
3. **#127 Verify the abstraction across all three** — extend the conformance suite to 3 adapters; document the seams Copilot strains; the live tri-dispatch via the running daemon is the operator/post-merge step (mechanically proven here by `verify-live-hooks.ts` + the 3-adapter conformance test).

## Files likely to change
- `packages/adapters/copilot/**` — new package (NEW).
- `packages/dispatcher/src/adapters.ts` — register copilot.
- `packages/dispatcher/src/gates/pr-ready.ts` — `extractCommand` reads `toolArgs` (Copilot) alongside `tool_input.command`.
- `packages/core/src/config.ts` — `copilot` in `GLOBAL_DEFAULTS.adapters`.
- `packages/dispatcher/package.json` — depend on `@middle/adapter-copilot`.
- `packages/dispatcher/test/adapter-conformance.test.ts` — `knownAdapters()` now 3.
- `packages/dashboard/src/db-deps.ts` — slot-pill fallback includes copilot.

## Key decisions (see decisions.md)
- **`sessionEnd → agent.stopped`** — Copilot's only session/turn boundary hook; required for done/blocked/failed classification (the implementation drive's done-path needs `agent.stopped`). The documented seam strain.
- **`resolveTranscriptPath` derives** `<cwd>/.copilot/session-state/<sessionId>/events.jsonl` (no `transcript_path` in payload).
- **No auth symlink** (gh auth).

## Out of scope
- Adding copilot to the **state-issue rate-limit pair** (`parser.ts`/`recommender.ts` hardcode `{claude,codex}`) — that's **schema-bound** to `state-issue.v1.md`, a deliberate exception (codex #63); generalizing is a schema v2 change.
- Full 3-way live daemon dispatch (operator/post-merge step; the running daemon runs `main`, which lacks this branch's copilot registry).

## Open questions
- Copilot's exact custom-skill invocation syntax (`/implementing-github-issues` vs `skill` tool) + skill-mirroring location — verified on a live run (the Codex precedent: prompt text mirrors the slash form, marked a live-verified tightening point).
