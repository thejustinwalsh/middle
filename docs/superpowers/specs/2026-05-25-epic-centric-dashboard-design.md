# Design — Epic-centric dashboard (browse Epics, progress, agents, force-dispatch)

**Date:** 2026-05-25
**Status:** approved for planning

## Problem

The shipped dashboard mirrors what `middle` *models*: runner state (the `workflows`
table) and the recommender's *ranked* output (the state issue's `readyToDispatch`).
It has no first-class notion of an **Epic backlog**. An operator cannot open the
dashboard and see "every open Epic in this repo, how far along it is, which agent
is on it, and dispatch a free slot against one." That interface — a clean human
shortcut over GitHub's issue UI that surfaces high-value content and decisions —
was never modeled, so it was never built.

Audit confirms the gap is architectural, not cosmetic:

- The **poller is resume-only** (`packages/dispatcher/src/poller.ts`) — it watches
  parked workflows for unblocking events; it never enumerates a repo's Epics.
- The **state issue** carries only the recommender's ranked Epics plus decision
  content (`needsHumanInput`, `blocked`, `excluded`) and only sub-issue **counts**
  (`schemas/state-issue.v1.md`: "Sub-issues never appear on their own").
- The **workflows table** tracks runners (`epic_number`, `current_sub_issue`,
  `pr_number`), not the backlog — no sub-issue list, no open/closed breakdown.
- There is **no `GET /api/epics`** and no per-Epic progress anywhere.

What already exists to build on:

- **Force-dispatch is ready**: `POST /control/dispatch` takes
  `{repo, repoPath, epicNumber, adapter}`, gates on a free slot (429), guards
  double-dispatch (409), and kicks the auto-loop (`hook-server.ts` →
  `startDispatchImpl` in `main.ts`). The dashboard's dispatch button only 404s
  because the SPA action was never wired (`dashboard/src/api.ts:166`).
- **Free-slot accounting**: `hasFreeSlot(state, adapter)` + per-adapter/repo/global
  slot state (`slots.ts`, `workflow-record.ts:countActiveImplementationSlots`).
- **The recommender already reads the Epic→sub-issue graph from GitHub**
  (`gh api /repos/{owner}/{repo}/issues/{n}/sub_issues`) — the seed of an
  Epic-listing capability; today it lives in a skill, not a reusable module.
- **Decision content is already parsed** from the state issue by `db-deps.ts`.

## Decisions (settled in brainstorming)

1. **Data source:** the daemon **caches** Epics + progress in the db and refreshes
   on an interval + on events; `/api/epics` reads the cache (fast, quota-friendly).
2. **Scope:** the **full open-Epic backlog** per repo — ready, blocked, in-flight,
   untouched — browsable and filterable, not just the recommender's actionable set.
3. **Dispatch UX:** the adapter picker **pre-selects the recommender's choice** (the
   state-issue Ready row's adapter) when present, overridable; else config default.
4. **View role:** **Epics is the primary/default landing view.** The repo/runner
   "Dashboard" tab stays but is demoted; nothing is deleted in v1.

## Architecture (where each piece lives)

The CLI composition root (`packages/cli/src/daemon-entry.ts`) is unchanged. New
work splits along the existing dependency direction (`dashboard → dispatcher`):

- **dispatcher** owns the **cache table**, the **refresh loop**, and the **new
  GitHub reads** — it already owns `github.ts`, the poller, slots, and
  `/control/dispatch`.
- **dashboard** owns the **`/api/epics` read** and the **`Epics` SPA view** — its
  `db-deps.ts` already deep-imports dispatcher modules, so reading the cache table
  is in-pattern.
- **Force-dispatch reuses the existing `/control/dispatch`** route on the same
  port — the same control-plane pattern the Queue tab uses via `control-client.ts`.
  No new dispatch engine.

## 1. Epic cache (dispatcher)

New migration `packages/dispatcher/src/db/migrations/004_epics.sql`:

```sql
CREATE TABLE epics (
  repo          TEXT    NOT NULL,
  number        INTEGER NOT NULL,
  title         TEXT    NOT NULL,
  state         TEXT    NOT NULL,            -- 'open' | 'closed'
  labels_json   TEXT    NOT NULL DEFAULT '[]',
  sub_total     INTEGER NOT NULL DEFAULT 0,
  sub_closed    INTEGER NOT NULL DEFAULT 0,
  gh_updated_at TEXT,                        -- GitHub updated_at, for staleness
  last_refreshed INTEGER NOT NULL,           -- epoch ms of our last write
  PRIMARY KEY (repo, number)
);
```

New module `packages/dispatcher/src/epics-cache.ts`:

- `refreshEpics(db, repo, github): Promise<void>` — lists the repo's open Epics,
  fetches each one's sub-issue progress, and **upserts** rows; Epics that vanish
  from the open set are marked `closed` (not deleted, so a just-closed Epic doesn't
  flicker out mid-view). One pass = one `listOpenEpics` + N `subIssueProgress` calls.
- `readEpics(db, repo): EpicRow[]` — the cache read the dashboard deps call.

Refresh triggers (a small `runEpicsRefreshLoop` wired in the daemon loop set):

- **Interval** — config `epics.refresh_interval_seconds` (default **60**).
- **Event-driven** — after a dispatch (`afterDispatch`) and after the poller's
  PR/issue reconcile, refresh just that repo, reusing the existing observer hooks.
- **Manual** — `POST /api/epics/:repo/refresh` forces one pass and returns the
  fresh list (the view's "refresh" affordance).

**Epic definition:** an open issue that is a **parent in GitHub's native sub-issue
graph** — the same classification the recommender skill uses. Standalone
dispatch-unit issues (no sub-issues) are out of v1; a later toggle can fold them in.

## 2. GitHub reads (new methods on `github.ts`)

Two methods on the existing `GithubClient`, both via `gh api`, mirroring the
recommender's `sub_issues` technique:

- `listOpenEpics(repo): Promise<{ number; title; state; labels: string[] }[]>` —
  open issues that have ≥1 sub-issue.
- `subIssueProgress(repo, n): Promise<{ total: number; closed: number }>`.

These are the **only** new outbound calls and run on the refresh loop, never per
page-view — the banner's GitHub quota stays cheap.

## 3. Endpoint + wire type

`GET /api/epics?repo=<slug>` → `EpicCard[]`. Each card **joins three in-system
sources** (no new GitHub calls on read):

```ts
export type EpicCard = {
  repo: string;
  number: number;
  title: string;
  progress: { closed: number; total: number };       // from the cache
  runner: {                                           // from workflows (if in-flight)
    adapter: string;
    state: string;
    currentSubIssue: number | null;
    session: string;
    prNumber: number | null;
  } | null;
  decision: {                                         // from the state issue
    label: string;                                    // e.g. 'awaiting reply', 'ready for review'
    oneLiner: string;
    link?: string;
  } | null;
  dispatch: {
    inFlight: boolean;                                // hasNonTerminalEpicWorkflow → 409 guard
    recommendedAdapter: string | null;               // state-issue Ready row's adapter (picker default)
    freeSlots: { adapter: string; available: boolean }[]; // hasFreeSlot per configured adapter
  };
};
```

New `DashboardDeps` methods, both reading the cache + existing joins:
`listEpics(repo): Promise<EpicCard[]>` and the manual `refreshEpics(repo)` trigger
(wired only in daemon mode; standalone dashboard returns the cache as-is).

`POST /api/epics/:repo/refresh` → forces a refresh, returns the fresh list.

## 4. Epics SPA view (primary tab)

`App.tsx` view state becomes `"epics" | "dashboard" | "queue" | "settings"` with
**`"epics"` the default**. New `Epics.tsx`:

- **Repo filter** at top (a select / pill row over the tracked repos).
- Each Epic is a **card**: `#N title` · a **progress bar** (`closed/total`
  sub-issues) · an **agent badge** (adapter + state, or "idle") · a **decision
  callout** when the state issue flags it (paused question / blocked /
  ready-for-review) · and a **Dispatch control**.
- **Dispatch control:** an adapter `<select>` populated from `config.adapters`,
  **pre-selected to `dispatch.recommendedAdapter`** (else config default), plus a
  Dispatch button. Disabled when `dispatch.inFlight` or no free slot for the chosen
  adapter; inline 409/429 feedback through the existing **guard funnel**.
- In-flight cards deep-link to the existing **`Inspector`** drawer.

Progress is a **bar (N/M)**, not a per-sub-issue checklist — that bounds the cache
to the two new GitHub calls. A full per-sub-issue breakdown is a later
expand-on-demand.

## 5. Force-dispatch wiring

The SPA posts to a new **`POST /api/epics/:repo/:n/dispatch`** with `{ adapter }`.
This is a thin daemon-hosted shim (in `db-deps.ts`, wired only when the daemon hosts
the routes): it **resolves `repoPath` server-side** from `repo_config` so the browser
never handles a filesystem path, then forwards to the existing `/control/dispatch`
entry. The shim — rather than calling `/control/dispatch` from the browser directly —
keeps `repoPath` resolution and adapter validation in the package the dashboard
already owns, leaves the dispatcher's control contract untouched, and lets a
standalone (non-daemon) dashboard cleanly 404 it. `epicNumber` and `adapter` come from
the card. Slot-gated client-side (disabled button) and server-side (429);
collision-guarded (409); both surfaced via the guard funnel.

## 6. Testing

- **Cache:** `refreshEpics` against a fake GitHub client (upsert, closed-marking,
  progress math); migration applies cleanly.
- **GitHub:** `listOpenEpics` / `subIssueProgress` parse fixture `gh api` output.
- **Endpoint:** `/api/epics` join against an in-memory db + fake state gateway —
  asserts the cache/workflows/state-issue merge and the `dispatch` block
  (recommendedAdapter, freeSlots, inFlight).
- **SPA:** `Epics.tsx` renders cards + progress + decision callout against a fake;
  the dispatch control disables correctly and posts the chosen adapter; nav defaults
  to Epics and switches among the four views.
- **control-client:** dispatch POST shape + error surfacing.
- Full `bun test` + `bun run typecheck` + `bun run lint` green.

## Out of scope

- Per-sub-issue checklist rendering (v1 shows the progress bar / counts only).
- Closed-Epic history view.
- Standalone (sub-issue-less) dispatch-unit issues in the browse list.
- Auth on the dashboard surface (localhost-only, unchanged).
- Any change to `/control/dispatch` dispatch *semantics* beyond resolving `repoPath`
  server-side.
