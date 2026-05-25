# Issue #48: Auto-dispatch and limits (Epic, Phase 8)

**Link:** https://github.com/thejustinwalsh/middle/issues/48
**Branch:** middle-issue-48

## Goal
Make dispatch autonomous within limits: slot accounting that gates the enqueue path, the auto-dispatch loop that consumes it, a per-repo opt-in toggle + pause/resume, runtime complexity-pause routing to `waiting-human`, and the `approved`-label override. After this Epic, with auto-dispatch enabled on middle's own repo, ready Epics auto-dispatch within their slot limits — and nothing dispatches over the complexity ceiling without `approved`. (Scheduling the recommender on cron is out of scope here, tracked as follow-up `#135`.)

## Approach
- Build on what already exists: `countActiveImplementationSlots` (per-adapter/total/global, recommender row excluded) is the slot-counting primitive; `rate-limits.ts` is the rate-limit source of truth; the recommender's `triggerAutoDispatch` dep is the already-stubbed seam; the implementation workflow's `asked-question` park already routes to `waiting-human`. Each phase adds the missing enforcement/wiring on top rather than re-architecting.
- The auto-dispatch loop is a pure-ish function with injected deps (read state issue, slot state, rate-limit state, repo gating, enqueue) so it's unit-testable without the engine; the daemon wires the four triggers to it.
- A "complexity pause" is a variety of the existing `asked-question` park, distinguished by a `kind` field the agent writes into `.middle/blocked.json`. The dispatcher reads it, routes to `waiting-human` (unchanged spine), and surfaces it so the recommender labels it `complexity pause`. No pre-dispatch ceiling gate is ever added.
- TDD throughout (the sub-issues all cite the `test-driven-development` skill): test first, then implement.

## Phases (one per open sub-issue)
1. **#49 — Slot tracking + enforcement in the enqueue path.** `packages/dispatcher/src/slots.ts`: derive used/max per-adapter, per-repo, global from live `workflows` state + merged config; an enqueue-guard that refuses when no slot is free; recommender slot excluded. Tests: at-capacity, free-slot, per-adapter-vs-global.
2. **#50 — Auto-dispatch loop (four trigger events).** `packages/dispatcher/src/auto-dispatch.ts`: the spec's loop — walk `readyToDispatch`, skip rate-limited adapters + exhausted slots, decrement local counters, no-op for a disabled repo. Wire the four triggers (recommender-run completes, workflow terminal transition, rate-limit change, manual `mm dispatch`) in `main.ts` + the recommender seam. Tests: normal pass, rate-limited-adapter skip, slots-exhausted stop.
3. **#51 — Per-repo `auto_dispatch` toggle + pause/resume.** `repo_config` helpers for `paused_until`; the loop checks both the `[recommender] auto_dispatch` toggle (default false) and pause state. `mm pause <repo>` / `mm resume <repo>` / `mm config <repo> <key> <value>`. Tests: toggle off, toggle on, paused-until-in-future.
4. **#52 — Route sub-issue complexity overruns to waiting-human.** `BlockedSentinel` gains an optional pause `kind`; a complexity-kind park routes to `waiting-human` and is surfaced for the recommender's `complexity pause` label; `complexity_ceiling` (merged config, default 3) injected into the agent brief. Assert no pre-dispatch ceiling check in the loop. Tests: overrun routes to waiting-human; in-ceiling does not pause.
5. **#53 — `approved`-label handling for complexity pauses.** Read the Epic's `approved` label; when present, the brief tells the agent it may proceed past an overrun with a best-judgment call; without it, the overrun pauses (#52). Manual `mm dispatch` stays slot-limited and is logged `source: 'manual'`. Tests: approved proceeds, non-approved pauses, manual is slot-limited.

## Files likely to change
- `packages/dispatcher/src/slots.ts` (new) — slot derivation + enqueue guard
- `packages/dispatcher/src/auto-dispatch.ts` (new) — the loop
- `packages/dispatcher/src/repo-config.ts` (new) — `repo_config` row helpers (paused_until, toggle snapshot)
- `packages/dispatcher/src/main.ts` — wire the four auto-dispatch triggers; pass complexity_ceiling/approved into deps
- `packages/dispatcher/src/workflows/implementation.ts` — complexity-pause surfacing + brief injection of ceiling/approved
- `packages/dispatcher/src/recommender-run.ts` / `workflows/recommender.ts` — wire `triggerAutoDispatch`
- `packages/core/src/adapter.ts` (+ `packages/adapters/claude/src/classify.ts`) — `BlockedSentinel` pause `kind`
- `packages/cli/src/commands/pause.ts`, `resume.ts`, `config.ts` (new) + `packages/cli/src/index.ts` — CLI surface
- `packages/dispatcher/src/index.ts` — export new public surface; per-folder docs as needed
- tests alongside each

## Out of scope
- Slot pills + auto-dispatch toggle UI in the dashboard (Phase 9)
- The agent-side fork mechanic / pause decision (the `implementing-github-issues` skill) — #52 defines only the sentinel contract the dispatcher reads
- Applying the `approved` label (a human action)
- The waitFor/resume plumbing (Phase 5 — already built)

## Open questions
- None blocking. The `complexity pause` surfacing mechanism (dispatcher posts a recognizable comment that the recommender classifies, vs. a label) will be resolved during #52 against the existing `postQuestion` pattern and the recommender skill's `needs-human` classification — both already reference `complexity pause`.
