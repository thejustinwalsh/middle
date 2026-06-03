# Issue #187: feat(dashboard): file-mode Epic display (epic_ref + file:// links)

**Link:** https://github.com/thejustinwalsh/middle/issues/187
**Branch:** middle-issue-187

## Goal
Make the dashboard's `/api/*` plane carry and render the file-mode Epic
identifier (`epic_ref`, a slug) so file-mode workflows — `epic_number IS NULL`,
`epic_ref = '<slug>'` — show a `file://planning/epics/<slug>.md` link instead of
a blank cell, with github-mode rows rendering exactly as they do today.

## Approach
- Plumb `epic_ref` through the read path the dashboard already uses: the
  workflows-table column (added by migration 009) → `getWorkflow` (for the
  bridge) and `db-deps` (for the `/api/*` responses) → the wire types → the UI.
- Add one small `EpicRef` component that owns the github-vs-file rendering rule,
  and use it in the surfaces the issue cites (the `db-deps.ts:83`-fed plane):
  the IN-FLIGHT runner row and the Inspector panel.
- Render rule: `epicNumber !== null` → `#N` (unchanged, no link — preserves
  today's exact github-mode output); else `epicRef !== null` → the slug as a
  `file://planning/epics/<slug>.md` link; else the surface's existing fallback.
- Bridge: `bridgeWorkflowsToBus` emits `epicRef` alongside `epic`.
- Read-only change — no dispatch write path is touched (`createWorkflowRecord`
  still doesn't set `epic_ref`; that's file-mode dispatch, out of scope).

## Phases
This is a standalone issue (no sub-issues) — one phase, verified as a unit.
1. file-mode Epic display — plumb `epic_ref` (dispatcher read path + db-deps +
   wire), add `EpicRef`, render in RunnerRow + Inspector, emit in the bridge,
   with unit + integration (real `Bun.serve` + migrated db) coverage.

## Files likely to change
- `packages/dispatcher/src/workflow-record.ts` — `WorkflowRecord.epicRef`,
  internal `WorkflowRow.epic_ref`, map it in `getWorkflow` (bridge read path).
- `packages/dashboard/src/db-deps.ts` — select `epic_ref`, add to
  `WorkflowRow` + `WORKFLOW_COLUMNS`, project into RunnerSummary/RunnerPanel.
- `packages/dashboard/src/wire.ts` — `epicRef: string | null` on `RunnerSummary`
  and `RunnerPanel`.
- `packages/dashboard/src/app/components/EpicRef.tsx` — new shared renderer.
- `packages/dashboard/src/app/components/RunnerRow.tsx`,
  `.../Inspector.tsx` — render via `EpicRef`.
- `packages/dashboard/src/bridge.ts` — emit `epicRef`.
- `packages/dashboard/test/helpers.ts` — `seedWorkflow` gains an `epicRef` opt.
- Tests: `workflow-record`, `db-deps` (deps), `sse` (bridge), a new
  `epic-ref.test.tsx` (component), and `api.test.ts` (integration: file-mode
  row → `/api/repos/:repo` + `/api/sessions/:session` carry `epicRef`).

## Out of scope
- File-mode dispatch endpoint via the dashboard UI (per the issue).
- Sub-issue rendering from the Epic file (per the issue).
- The `/control/events` plane (`main.ts` `broadcastWorkflow` → `Queue` tab):
  a separate data path the issue does not cite (it names `db-deps.ts:83`). The
  Queue tab keeps showing `—` for file-mode rows until a follow-up plumbs
  `epicRef` through the control feed. Noted as a discovery follow-up.
- Populating `epic_ref` on insert (`createWorkflowRecord`): the migration's
  design says github-mode should write `epic_ref = String(epic_number)`, but no
  AC requires it and github rendering keys on `epic_number`. File-mode dispatch
  owns the write path. Noted as a follow-up.

## Open questions
- "no GitHub link in file mode" + "github-mode rows keep their numeric link":
  github epics render as plain `#N` text today (no anchor). The hard constraint
  is AC4 "no behavior change for github-mode rows", so `EpicRef` preserves the
  plain `#N` text for github mode and adds the `file://` anchor only for file
  mode. Resolved by honoring the no-behavior-change constraint literally.
