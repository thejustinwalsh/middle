# Issue #32: Human-in-the-loop and review-driven resume flow

**Link:** https://github.com/thejustinwalsh/middle/issues/32
**Branch:** middle-issue-32

## Goal
Give the `implementation` workflow a **park → external-signal → resume** spine so an agent
can hand control back to a human (asked a question) or to a reviewer (PR-ready), and later
resume a fresh session in the same worktree with the answer / review threads in context.
`APPROVED` ends the loop; a never-satisfied review loop is bounded to 5 rounds.

## Approach
- The Epic's 4 open sub-issues are the phases. Build down them on one branch / one PR.
- **bunqueue reality check (load-bearing):** the installed `bunqueue@2.7.12` `Workflow` DSL
  filters `.path()` / loop bodies to **steps only** — a `waitFor` nested in a branch path is
  silently dropped (`workflow.js:46`). `waitFor` must be a **top-level node**. `engine.signal(execId, event, payload)`
  targets a specific execution and sets `exec.signals[event]`; the matching top-level `waitFor`
  then advances. `buildContext` passes `signals` **by reference** (`runner.js:178`), so a step can
  pre-seed `ctx.signals[event]` to make a downstream top-level `waitFor` fall through without parking.
  There is no goto/loop-back. The spec's idealized nested graph (§"implementation workflow") is
  therefore expressed as: **a top-level `waitFor` spine + re-enqueue for additional rounds**, which
  matches the spec's own `// loop back via re-enqueue` annotation.
- Reuse the existing `waitfor_signals` table + `armWaitForSignal`/`isWaitForArmed` (built in
  Phase 2 for the watchdog sentinel re-arm). Add a `consumeWaitForSignal` (delete on resume) and a
  per-workflow round counter (`meta_json` or a column).
- Poller talks to GitHub via the `gh` CLI subprocess pattern already used in `state-issue.ts`.
- Tests follow the existing `implementation-workflow.test.ts` / adapter test style: stub tmux +
  SessionGate + adapter, drive the real embedded engine, assert DB state + signal flow.

## Phases
1. **#33 waitFor signal spine** — branch on `classifyStop` outcome; asked-question + done paths arm
   a `waitfor_signals` row, end the session (keep the worktree), set state `waiting-human`, park on a
   top-level `waitFor`; resume re-enters carrying the resume reason; row consumed on resume.
2. **#34 classifyStop sentinel** — `.middle/blocked.json` → `{kind:'asked-question', sentinelPath}`
   with the question/context surfaced to the workflow; no sentinel → `done`/`bare-stop`.
3. **#35 GitHub poller** — for Epics with an armed wait, fire `epic-<n>-answered` on a new human
   reply, and `epic-<n>-review-resolved` on a review transition (CHANGES_REQUESTED/label → resume;
   APPROVED **or** 0-actionable re-review → resolved). Idempotent + rate-limit resilient.
4. **#36 resume logic** — fresh session re-primed per reason; review-changes follows the skill's
   "Addressing review feedback" per-round procedure (batch → internal review loop → single push →
   reply in-thread → re-request → re-park); round counter per pass; cap (default 5) → `waiting-human`;
   APPROVED ends the loop.

## Files likely to change
- `packages/dispatcher/src/workflows/implementation.ts` — the park/resume spine (#33, #36)
- `packages/dispatcher/src/workflow-record.ts` — `consumeWaitForSignal`, round-counter helpers (#33, #36)
- `packages/dispatcher/src/db/migrations/00X_*.sql` — round counter / signal metadata if a column is needed
- `packages/adapters/claude/src/classify.ts` + `prompt.ts` — sentinel contents, resume prompt framing (#34, #36)
- `packages/core/src/adapter.ts` — `StopClassification` enrichment if contents are surfaced via the type (#34)
- `packages/dispatcher/src/poller.ts` (new) + wiring in `main.ts` — the GitHub poller (#35)
- `packages/dispatcher/test/*` + `packages/adapters/claude/test/*` — tests per phase

## Out of scope
- Mechanical verification gates (Phase 6) — the poller fires on review state; it does not run gates.
- Auto-dispatch / slot enforcement (Phase 8) — parking frees the slot conceptually; the auto-dispatch
  loop that consumes freed slots is Phase 8.
- Dashboard surfaces (Phase 9) — "asked question" / "waiting review" rendering.
- middle never merges — APPROVED is terminal; the human merges.

## Open questions
- None blocking. The round-counter storage (new column vs `meta_json`) and the exact re-enqueue shape
  for multi-round loops will be resolved during #36 by building (the spike in #33 validates the core
  park/signal mechanic against the real engine first).
