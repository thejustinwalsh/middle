# Issue #60: CodexAdapter (Epic — Phase 10)

**Link:** https://github.com/thejustinwalsh/middle/issues/60
**Branch:** middle-issue-60

## Goal
Ship the second `AgentAdapter` (Codex), add per-CLI adapter selection across the
implementer and recommender paths, and prove the adapter abstraction holds across
both adapters — fixing the interface or any leak where it doesn't.

## Approach
- Mirror the ClaudeAdapter package structure (`index.ts` + `classify.ts` /
  `hooks.ts` / `prompt.ts` / `transcript.ts`) for Codex, implementing every
  `AgentAdapter` member to the spec's "CodexAdapter specifics".
- Codex's empirically-observed bits (hook event names, transcript location/format,
  rate-limit message, force-include syntax, auto-mode mechanism) are implemented as
  the spec's start-generous baseline — the interface is designed to absorb tightening
  once observed on a live run. Document each assumption in `decisions.md`.
- Replace the two hardcoded `getAdapter` registries and the six "claude-only" gates
  with a shared registry + a pure `selectAdapter(...)` that encodes the spec's four
  selection rules (label override → default → rate-limit switch → skip).
- Prove the abstraction with an automated test that drives both adapters through the
  same workflow path; audit for adapter-specific logic that leaked outside the
  adapter packages and fix it (the registry hardcodes are the known leak).

## Phases (= open sub-issues)
1. **#61 Implement the CodexAdapter** — full `AgentAdapter` impl + unit tests for
   `buildLaunchCommand`, `buildPromptText`, `installHooks`, `classifyStop`,
   transcript reads, rate-limit detection.
2. **#62 Per-CLI adapter selection** — shared adapter registry; pure `selectAdapter`
   with the four rules; wire into manual dispatch + the claude-only gates; recommender
   skill prose + state-issue schema already record per-Epic adapter (verify/extend).
3. **#63 Verify the abstraction holds** — automated test exercising both adapters
   through one workflow path; leak audit + fix; document interface findings.

## Files likely to change
- `packages/adapters/codex/src/{index,classify,hooks,prompt,transcript}.ts` — new
- `packages/adapters/codex/test/adapter.test.ts` — new
- `packages/adapters/codex/package.json` — barrel exports
- `packages/core/src/select-adapter.ts` (+ index export) — new `selectAdapter`
- `packages/core/test/select-adapter.test.ts` — new
- `packages/dispatcher/src/main.ts`, `packages/cli/src/commands/docs.ts` — shared registry
- `packages/cli/src/commands/dispatch.ts`, `packages/dispatcher/src/recommender-run.ts`,
  `packages/dispatcher/src/documentation-run.ts` — generalize claude-only gates
- `packages/skills/recommending-github-issues/SKILL.md` — adapter-selection prose (already present; verify)
- A cross-adapter workflow test (location TBD — dispatcher test)

## Out of scope
- Applying `agent:<name>` labels (a human action)
- The universal `hook.sh` (Phase 2, reused as-is)
- Tightening Codex regexes/event-names against a live run (future, once observed)

## Open questions
- The Epic headline criterion + #63's first criterion require a **live** dual-dispatch
  on a test repo with both CLIs in interactive tmux. Codex CLI is **not installed** in
  this sandbox and there are no OpenAI credentials, so the live run is an operator step.
  Everything else (adapter impl, selection logic, the automated same-path cross-adapter
  test, the leak audit) is delivered and verified here; the live run is surfaced in the
  reviewer's brief as the operator-executed acceptance step.
