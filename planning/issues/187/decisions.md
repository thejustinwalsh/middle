# Decisions — Issue #187

## github-mode renders plain `#N`, not an anchor
**File(s):** `packages/dashboard/src/app/components/EpicRef.tsx`
**Date:** 2026-05-29

**Decision:** `EpicRef` renders github-mode Epics (`epicNumber !== null`) as plain
`#N` text — no `<a>` — and renders only file-mode Epics as a `file://` link.

**Why:** The issue's Context says the dashboard "renders it as a numeric link to
GitHub", but the surfaces in fact render plain `#N` text today (no anchor exists
in `RunnerRow`/`Inspector`). AC4 is the hard constraint — "No behavior change for
github-mode rows." Adding a GitHub anchor would itself be a behavior change, so
the literal no-behavior-change reading wins: github mode keeps its exact current
plain-text output; file mode is the only new rendering. Resolved without a fork
(the constraint picks the winner).

## `EpicRef` owns the `#` prefix; the empty case is a `fallback` prop
**File(s):** `packages/dashboard/src/app/components/EpicRef.tsx`
**Date:** 2026-05-29

**Decision:** The component emits `#N` for github mode and the bare slug (no `#`)
for file mode; the both-null case renders a caller-supplied `fallback`.

**Why:** A slug is not an issue number, so prefixing it with `#` would be wrong.
The two callers differed in their pre-#187 empty rendering — `RunnerRow`/`Inspector`
showed `#—` (the `#` was outside the interpolation), so they pass `fallback="#—"`
to preserve byte-identical output, while the default `—` covers any future caller.

## file:// href + slug encoding
**File(s):** `packages/dashboard/src/app/components/EpicRef.tsx`
**Date:** 2026-05-29

**Decision:** `epicFileHref(slug)` → `file://planning/epics/${encodeURIComponent(slug)}.md`.

**Why:** AC2 names exactly `file://` + `planning/epics/<slug>.md`; the repo's
absolute root isn't known client-side, so the path stays repo-relative as the AC
specifies. `encodeURIComponent` collapses the slug to a single safe path segment
— a malformed value (`../`, quotes, angle brackets) can't traverse out of
`planning/epics/` or inject markup into the `href`. A normal kebab-case slug
encodes to itself (unreserved chars), so the common case is unchanged.

## Read-path only — the dispatch write path is untouched
**File(s):** `packages/dispatcher/src/workflow-record.ts`
**Date:** 2026-05-29

**Decision:** Added `epicRef` to `WorkflowRecord` + `getWorkflow` (the bridge's
read accessor) only. `createWorkflowRecord` still does not write `epic_ref`.

**Why:** #187 is a dashboard display issue (AC1–4 are all read/render/bridge). The
bridge (AC3) reads through `getWorkflow`, so the read path must carry `epicRef`;
populating it on insert is the file-mode dispatch workstream's job (explicitly out
of scope). github rendering keys on `epic_number`, so a null `epic_ref` on new
github rows is harmless. Migration 009's comment claims `createWorkflowRecord`
populates it — that's not yet true; filed as a follow-up rather than expanded into
this PR.

## Other epic-rendering surfaces (Queue tab, NEXT UP) left out of scope
**File(s):** `packages/dispatcher/src/main.ts` (`broadcastWorkflow`), `packages/dashboard/src/app/control-client.ts`, `packages/dashboard/src/db-deps.ts:307`, `packages/dashboard/src/app/components/Repos.tsx`
**Date:** 2026-05-29

**Decision:** Two adjacent epic-rendering surfaces keep their pre-#187 behavior:
the **Queue tab** (fed by `/control/events` → `ControlWorkflowFrame`) shows `—`
for file-mode rows, and **NEXT UP** (fed by the recommender's parsed state issue)
collapses a file-mode slug to `#0` via `Number(slug) || 0`. Neither is touched.

**Why:** The issue cites `db-deps.ts:83` — the `/api/*` plane (RunnerSummary /
RunnerPanel + the `bridge.ts` repo-channel nudge), which reads the
`workflows.epic_ref` column this issue is about. The other two surfaces read
*different sources*: the Queue's frame comes from the dispatcher daemon
(`main.ts`, the control plane — named by no AC), and NEXT UP comes from the
recommender's state-issue ranking (`readyToDispatch`), which doesn't emit
file-mode slugs yet (file-mode dispatch / recommender support is out of scope per
the issue). Both are genuinely separate data paths outside this change's blast
radius. Filed as discovery follow-ups (the NEXT UP one also notes a latent React
`key={n.epic}` collision once two file-mode rows both map to `#0`).
