# Design — Activity view (recommender + documentation run visibility)

**Date:** 2026-05-26
**Status:** approved for planning

## Problem

Every dashboard view filters to `kind = 'implementation'` — slots, the Queue
tab's in-flight list, and the Epic-centric view. So the daemon's **other** workflow
kinds are invisible: an operator can't see when the **recommender** last ran (or
whether it failed), nor whether the **documentation** (docs-auditor / fixup) bot is
running or erroring. The only signal today is the recommender's *output* (the state
issue) and a `repo_config.last_recommender_run` timestamp nothing surfaces.

This is the follow-up agreed after the Epic-centric dashboard (PR #152).

## What already exists (this is mostly a read + view)

Recommender and documentation runs **persist full `workflows` rows** —
`createWorkflowRecord` with `kind:"recommender"` / `kind:"documentation"`, each
carrying `state`, `created_at`, `updated_at`, `session_name`, `transcript_path`,
`worktree_path`, `last_heartbeat` (identical shape to implementation runs, with
`epic_number` null). The dashboard's existing `getRunnerPanel` / `getSessionEvents`
/ `getTranscript` deps already resolve any session regardless of kind. So this
feature adds a **read + a view**: no new persistence, and no GitHub calls on the
hot path (output links are built from data already in the row/`repo_config`).

## Decisions (settled in brainstorming)

1. **Scope:** non-implementation runs only — `recommender` + `documentation`.
2. **Placement:** a new **"Activity"** tab (5th), beside Epics / Dashboard / Queue / Settings.
3. **Window:** the most recent **N = 20 per kind**, newest-first, **including terminal
   runs** (the point is "did the last run fail" history).
4. **Layout:** **grouped by kind** — a "Recommender" section and a "Documentation"
   section, each newest-first.
5. **Drill-in:** **reuse the existing Inspector** (runner panel + event timeline +
   transcript + attach affordances); `epic` renders "—" for these runs.

## Architecture

A pure additive read along the existing `dashboard → dispatcher` seam, mirroring the
`/api/epics` shape from PR #152:

- **dashboard** owns a new `listRuns()` dep + `/api/runs` route + the `Activity.tsx`
  view + the `App.tsx` tab wiring.
- No dispatcher change required — `listRuns` reads `workflows` rows directly (the
  same db handle the other deps use).

## 1. Wire type

```ts
/** One non-implementation run (recommender / documentation) in the Activity view. */
export type RunSummary = {
  workflowId: string;
  kind: "recommender" | "documentation";
  repo: string;
  state: string;                 // launching | running | waiting* | completed | failed | ...
  /** session_name ?? workflowId — always set, so the row is drillable via the Inspector. */
  session: string;
  startedAt: number;             // created_at (epoch ms)
  updatedAt: number;
  /** updatedAt - startedAt for terminal runs; now - startedAt while active. */
  durationMs: number;
  active: boolean;               // false for terminal states (completed/compensated/failed/cancelled)
  hasTranscript: boolean;
  /** "see the result": recommender → state-issue URL; documentation → PR URL; else null. */
  outputLink: string | null;
};
```

## 2. Read (`db-deps.listRuns`)

New `DashboardDeps.listRuns(): Promise<RunSummary[]>`. Implementation: for each
non-implementation kind, query the top 20 rows newest-first and project:

```sql
SELECT id, repo, state, session_name, created_at, updated_at, transcript_path, pr_number
FROM workflows WHERE kind = ? ORDER BY created_at DESC LIMIT 20
```

Per row:
- `session` = `session_name ?? id` (mirrors `toRunnerSummary`, so the Inspector's
  `rowBySession` fallback resolves it).
- `active` = `state NOT IN (completed, compensated, failed, cancelled)` (reuse
  `TERMINAL_STATES`).
- `durationMs` = `active ? Date.now() - created_at : updated_at - created_at`.
- `hasTranscript` = `transcript_path !== null`.
- `outputLink`:
  - `recommender` → the repo's state issue, `https://github.com/<repo>/issues/<stateIssueNumber>`
    (from `repo_config.state_issue_number`, which `db-deps` already reads via
    `stateIssueNumber(repo)`); null if unrecorded.
  - `documentation` → `https://github.com/<repo>/pull/<pr_number>` when `pr_number`
    is set; else null.

Both kinds' results concatenated (recommender first), returned as one array; the
view groups by `kind`. No GitHub calls — links are string-built from existing data.

## 3. Route + client

- `GET /api/runs` → `RunSummary[]` — a new branch in `handleApi` (mirrors `/api/epics`;
  no path params).
- `api-client.ts`: `runs: () => getJson<RunSummary[]>("/api/runs")`.

## 4. SPA — `Activity.tsx` + `App.tsx`

`Activity.tsx` renders two `<section>`s — **Recommender** and **Documentation** —
each a newest-first list (empty state per section when none). Each row:
- a **state pill** (color: active = neutral/blue, `completed`/`compensated` = green,
  `failed`/`cancelled` = red),
- `repo`,
- relative **start time** + **duration**,
- an **output** link (`↗`) when `outputLink` is set,
- the row is a button → **opens the existing Inspector** for `session` (via the
  existing `onOpenInspector` path App already wires).

`App.tsx`:
- view state gains `"activity"`; a 5th nav tab `activity` (after `queue`, before
  `settings`).
- on entering the tab: fetch `api.runs()` + poll while open (matching the
  Queue/Epics pattern), and refetch on any `/control/events` workflow frame so an
  active recommender/docs run updates live.
- clicking a run reuses the existing `openInspector(session)` + `<Inspector>` drawer.

## 5. Testing

- **`listRuns` deps test** (in-memory migrated db via `makeDb` + `seedWorkflow`):
  seed a recommender, a documentation, and an implementation row → assert only the
  two non-impl kinds appear, newest-first, capped at 20 per kind; assert
  `active`/`durationMs`/`hasTranscript` and `outputLink` (recommender → issue URL
  from a seeded `repo_config.state_issue_number`; documentation → PR URL from
  `pr_number`; null when absent).
- **`/api/runs` route test** against fake deps.
- **`Activity.tsx` render test** (`renderToStaticMarkup`): both sections, state
  pills, output link present/absent, empty-state per section.
- **`App.tsx`:** nav has 5 tabs; the Activity branch renders.
- Full `bun test` + `bun run typecheck` + `bun run lint` green.

## Out of scope

- Implementation runs (covered by the Epic-centric + Queue views).
- A recommender output *diff* viewer (the state-issue link is the shortcut).
- Pausing / cancelling / re-running from this view — read-only, like the rest.
- Configurable N (fixed 20 per kind).
- A new dispatcher endpoint or persistence — this is a read over existing rows.
