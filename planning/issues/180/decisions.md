# Decisions — Issue #180

## Root cause: the dispatcher's in-place section seam was never wired
**File(s):** `packages/dispatcher/src/state-issue.ts`, `packages/dispatcher/src/workflows/recommender.ts`
**Date:** 2026-05-29

**Decision:** Wire `applyDispatcherSections` as the sole writer of the three
dispatcher-owned sections (In-flight / Rate limits / Slot usage), via a new
`reapply-dispatcher-sections` step in the recommender workflow that runs right
after the agent and overwrites those sections with canonical content.

**Why:** `grep` confirmed `applyDispatcherSections`/`updateDispatcherSections`
were defined + unit-tested but **never called in production**. So In-flight was
authored only by the recommender *agent*, reconstructing the line from the
`in_flight` prompt JSON — which carried no heartbeat (`InFlightSummary` and
`listActiveImplementationWorkflows` both lacked one). The renderer requires
`last heartbeat <rel>`, so the agent literally could not produce the canonical
5-field line → 4-field malformed line every time. Relaxing the parser (issue
option 2) was explicitly rejected as hiding the symptom.

**Evidence:** Issue #180 body; renderer at `renderer.ts:45` (5 fields) vs the
agent's reconstruction; `listActiveImplementationWorkflows` returned no heartbeat.

## Reapply is best-effort; verify is the parse gate
**File(s):** `packages/dispatcher/src/workflows/recommender.ts`
**Date:** 2026-05-29

**Decision:** The reapply step parses the agent body and overwrites the three
owned sections only if it parses. If the agent disobeyed and produced an
unparseable body, reapply skips (logs) and the existing `verify-state-issue-parses`
step surfaces the failure on the state issue and fails the run — a single
surfacing point, no double comment.

**Why:** A surgical section overwrite needs a parseable body; the agent emitting
the canonical empty placeholder (per the new prompt) guarantees that on the happy
path, while verify remains the safety net for the disobedient case (issue fix 3).
