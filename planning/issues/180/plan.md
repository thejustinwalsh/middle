# Issue #180: fix(dispatcher): recurring "In-flight" parse failure blocks auto-dispatch

**Link:** https://github.com/thejustinwalsh/middle/issues/180
**Branch:** middle-issue-180

## Goal
Stop the recurring `malformed "In-flight" item` parse failure that silently kills
auto-dispatch. Make the dispatcher the single source of truth for the three
dispatcher-owned sections (In-flight / Rate limits / Slot usage), and surface any
parse failure on the state issue instead of dying in stderr.

## Root cause
The dispatcher's in-place section seam (`applyDispatcherSections` /
`updateDispatcherSections` in `packages/dispatcher/src/state-issue.ts`) **exists
but is never called in production** — confirmed by grep. So In-flight is authored
only by the recommender *agent*, which reconstructs the line from the `in_flight`
JSON in its prompt. That JSON (`InFlightSummary`) carries no heartbeat, and
`listActiveImplementationWorkflows` doesn't return one either — so the canonical
5-field line (`… · last heartbeat <rel> · …`) can never be produced by the agent.
The renderer needs the heartbeat; the agent has no way to supply it → 4-field
malformed line, every time.

## Approach
Recommended fix (1) + (3) from the issue:
1. **Wire the dispatcher seam as the sole writer of the three owned sections.**
   After the agent runs, a new recommender-workflow step overwrites In-flight /
   Rate limits / Slot usage with canonical content built from the dispatcher's
   own state (heartbeat included). The agent is told to emit the empty-state
   placeholder for those sections (still consuming rate/slot data as ranking
   *input*) — it no longer authors them.
2. **Carry the heartbeat through the data layer** so canonical In-flight can be
   rendered (`listActiveImplementationWorkflows` → `lastHeartbeat`; formatted to
   the `<rel>` string the schema documents).
3. **Surface parse failures on the state issue** (fix 3) — the read-only
   auto-dispatch path currently logs `does not parse` only to stderr; comment it
   on the state issue (deduped so a debounce burst posts once).

## Phases
1. Data layer — heartbeat through `listActiveImplementationWorkflows` + context
2. Dispatcher SoT — build `DispatcherSections` from context; add the
   `reapply-dispatcher-sections` workflow step; wire it in both run paths
3. Prompt — stop the agent authoring the three dispatcher-owned sections
4. Surfacing — comment parse failures on the state issue from auto-dispatch (deduped)
5. Tests + round-trip regression guard

## Files likely to change
- `packages/dispatcher/src/workflow-record.ts` — `lastHeartbeat` on the active-workflow row
- `packages/dispatcher/src/workflows/recommender.ts` — context heartbeat, new step, prompt
- `packages/dispatcher/src/state-issue.ts` — helper to build `DispatcherSections` (heartbeat fmt)
- `packages/dispatcher/src/main.ts` / `recommender-run.ts` — wire the new dep; auto-dispatch surfacing
- tests across the above

## Out of scope
- Full eager dispatcher in-flight updates on every workflow transition (the
  schema's "between recommender runs" mechanism) — this fix makes the dispatcher
  the authoritative writer at the recommender-run boundary, which closes the bug.
- Relaxing the parser (issue option 2 — explicitly rejected as hiding the symptom).

## Open questions
- None blocking; the issue's recommendation (1)+(3) is unambiguous.
