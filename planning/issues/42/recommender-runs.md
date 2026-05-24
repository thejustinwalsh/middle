# Recommender hand-eyeball runs (#47)

Phase 7 closes by running the recommender's analysis against **middle's own repo** several
times, hand-reviewing the rankings, and iterating the `recommending-github-issues` skill for
observed gaps. Run headless (no live interactive agent loop), each "run" below is the skill's
procedure executed by hand against the live repo (`gh issue list`, `gh pr list`, the sub-issue
graph), with the resulting classification reviewed against what an operator would pick.

## Repo state at eyeball time (2026-05-24)

Dispatch units (Epics + standalone; sub-issues skipped):

| Unit | Kind | Open PR | Blocked by | Hand classification |
|---|---|---|---|---|
| #42 Recommender | Epic | #105 (draft) | — | **in-flight** (this workstream) |
| #91 Documentation conventions | Epic | #106 (draft) | — | **in-flight** |
| #48 Auto-dispatch | Epic | — | #42 | blocked |
| #54 Dashboard | Epic | — | #48 | blocked |
| #60 CodexAdapter | Epic | — | #54 | blocked |
| #64 Operator polish | Epic | — | #60 | blocked |
| #96 Docs harvester | Epic | — | #91 | blocked |
| #101 checkbox-revert trigger | standalone | — | — | **ready** |
| #103 Share repo policy | standalone | — | — | **ready** |
| #84 agent-queue: dispatch state | (state issue) | — | — | excluded |

The dependency chain (#48→#54→#60→#64, and #96→#91) is gated on the two in-flight Epics, so
only the two standalone issues are dispatchable now. Neither unblocks anything, so they rank by
sub-issue count (both 1) then `updatedAt`. This matches what I'd pick by hand: dispatch #101 /
#103, leave the chain blocked until #42 and #91 merge.

## Runs and the gaps each surfaced

- **Run 1 (baseline skill).** Classification was mostly right, but two units with open **draft**
  PRs (#42, #91) had no clear home: the skill's `needs-human` list says "the Epic's PR is
  awaiting human review", which would mis-file an actively-worked *draft* PR as needs-human.
  And nothing told the recommender to detect in-flight units from open PRs when the
  dispatcher's `in_flight` is empty/stale — risking a **double-dispatch** of #42/#91.
  → **Gap A** (PR cross-reference) and **Gap B** (draft vs ready PR).

- **Run 2 (after Gap A + B edits).** Added to Phase 2: cross-reference open PRs to the Epic by
  branch / `Closes #`, and never treat an Epic with an open PR as `ready`. Added to Phase 3: an
  open PR settles status first — **draft PR → in-flight** (don't rank/surface), **ready PR →
  needs-human**. Re-classifying: #42/#91 now correctly fall out as in-flight, the blocked chain
  is untouched, and the two standalone issues remain the only `ready` units. Correct.

- **Run 3 (state-issue exclusion).** Noticed #84 (`agent-queue:state`) is itself a candidate
  the skill never explicitly excludes — a recommender could rank its own surface.
  → **Gap C**: Phase 2 now explicitly excludes the state issue (and any `agent-queue:state`
  issue) from the dispatch-unit set. Re-classifying: #84 drops to `excluded`. Correct.

- **Run 4 (final).** The full classification (table above) rendered to a state-issue body
  parses against the schema, validates, and round-trips byte-identically:

  ```text
  parse: OK
  validate: OK
  round-trip byte-identical: true
  ```

  The rankings match what I would pick by hand. No further gaps surfaced.

## Skill changes made (and why)

1. **Phase 2 — cross-reference open PRs (Gap A).** The dispatcher's `in_flight` is authoritative
   when present but can be stale; matching open PRs to Epics catches in-flight/awaiting-review
   units anyway, preventing a double-dispatch of a workstream already underway.
2. **Phase 2/3 — draft vs ready PR (Gap B).** A *draft* PR means the agent is still working
   (in-flight: don't rank, don't surface); a *ready* (non-draft) PR means it's awaiting human
   review (`needs-human`). The old text collapsed both into needs-human.
3. **Phase 2 — exclude the state issue (Gap C).** The issue being rewritten (and any
   `agent-queue:state` issue) is the dispatcher's surface, never a dispatch unit.

All three are classification-accuracy fixes, not mechanics changes (workflow mechanics are
#43–#46). The canonical skill (`packages/skills/...`) and the `mm init` mirror
(`packages/cli/src/bootstrap-assets/skills/...`) were kept in sync via `bun run sync-skills`.
