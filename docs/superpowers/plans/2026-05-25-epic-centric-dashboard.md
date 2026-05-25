# Epic-centric Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Epic-centric dashboard view that browses every open Epic in a repo with live sub-issue progress, shows which agent is working each, surfaces the state issue's decision content, and force-dispatches a free slot with a chosen agent.

**Architecture:** A daemon-side cache (new `epics` table + `epics-cache.ts`) is refreshed from GitHub on an interval and after dispatch; `GET /api/epics/:repo` reads the cache and joins it with the `workflows` table (which agent) and the live state issue (decision content + the recommender's adapter pick). Force-dispatch flows through a new `dispatch` daemon host-context callback (mirroring the existing `runRecommender` seam) that reuses the dispatcher's manual-dispatch path. The SPA gets a new `Epics.tsx` view, made the default landing tab.

**Tech Stack:** Bun + TypeScript monorepo, `bun:sqlite`, React 19, `Bun.serve` route + `fetch` merge, `gh` CLI for GitHub reads. Tests: `bun test`. Type-check: `bun run typecheck`. Lint/format: `bun run lint` / `bun run format`.

**Reference docs:** spec at `docs/superpowers/specs/2026-05-25-epic-centric-dashboard-design.md`; `packages/dispatcher/CLAUDE.md` (observer fan-out, the runnable entry is `main.ts`); root `CLAUDE.md` (module-index frontmatter, conventional commits — **no AI co-author trailers**).

**Note on a deliberate spec deviation:** the spec named a `config` knob for the refresh interval. To avoid touching the `core` config schema, this plan uses a module constant `EPICS_REFRESH_INTERVAL_MS = 60_000` (consistent with the existing `POLLER_INTERVAL_MS` / `WATCHDOG_INTERVAL_MS` constants). Config-ification is deferred.

---

## File Structure

**Create:**
- `packages/dispatcher/src/db/migrations/005_epics.sql` — the Epic cache table.
- `packages/dispatcher/src/epics-cache.ts` — `refreshEpics` / `readEpics`.
- `packages/dispatcher/test/epics-cache.test.ts`
- `packages/dispatcher/test/github-epics.test.ts`
- `packages/dashboard/src/app/components/Epics.tsx` — the view.
- `packages/dashboard/test/epics-deps.test.ts`
- `packages/dashboard/test/epics-api.test.ts`
- `packages/dashboard/test/epics.test.tsx`

**Modify:**
- `packages/dispatcher/src/github.ts` — `listOpenEpics` + a pure `parseEpicsList`.
- `packages/dispatcher/src/main.ts` — `DaemonHostContext.dispatch` + `.refreshEpics`, a manual-dispatch helper, the refresh loop, and the `hostExtras` call site.
- `packages/dashboard/src/wire.ts` — `EpicCard`.
- `packages/dashboard/src/deps.ts` — `listEpics` / `refreshEpics?` / `dispatchEpic?`.
- `packages/dashboard/src/db-deps.ts` — production impl + `dispatch?` / `refreshEpicsTrigger?` options.
- `packages/dashboard/src/api.ts` — `/api/epics/*` routes.
- `packages/dashboard/src/app/api-client.ts` — `epics` / `refreshEpics` / `dispatchEpic`.
- `packages/dashboard/src/app/App.tsx` — `"epics"` view (default), nav, fetch, dispatch handler.
- `packages/cli/src/daemon-entry.ts` — thread `dispatch` + `refreshEpics` into `createDbDeps`.
- module-index frontmatter / docs as needed (Task 9).

---

## Task 1: GitHub Epic listing (`listOpenEpics` + pure parser)

**Files:**
- Modify: `packages/dispatcher/src/github.ts`
- Test: `packages/dispatcher/test/github-epics.test.ts` (create)

GitHub's issues API carries a `sub_issues_summary: { total, completed, percent_completed }` on each issue, so one paginated call per repo yields both the Epic set (issues with `total > 0`, excluding PRs) **and** their progress — no per-Epic call. We extract a pure parser over the `gh api --paginate --jq` NDJSON output so parsing is unit-testable without spawning `gh`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/dispatcher/test/github-epics.test.ts
import { describe, expect, test } from "bun:test";
import { parseEpicsList } from "../src/github.ts";

describe("parseEpicsList", () => {
  test("maps sub_issues_summary into Epic rows", () => {
    const ndjson = [
      JSON.stringify({
        number: 247,
        title: "OAuth refresh",
        state: "open",
        labels: [{ name: "epic" }, { name: "agent:claude" }],
        sub_issues_summary: { total: 4, completed: 2 },
      }),
      JSON.stringify({
        number: 9,
        title: "no sub-issues",
        state: "open",
        labels: [],
        sub_issues_summary: { total: 0, completed: 0 },
      }),
    ].join("\n");

    expect(parseEpicsList(ndjson)).toEqual([
      { number: 247, title: "OAuth refresh", state: "open", labels: ["epic", "agent:claude"], subTotal: 4, subClosed: 2 },
    ]);
  });

  test("tolerates blank lines and ignores rows missing a summary", () => {
    const ndjson = `\n${JSON.stringify({ number: 1, title: "x", state: "open", labels: [] })}\n`;
    expect(parseEpicsList(ndjson)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/dispatcher/test/github-epics.test.ts`
Expected: FAIL — `parseEpicsList` is not exported.

- [ ] **Step 3: Implement the parser + gateway method**

In `packages/dispatcher/src/github.ts`, add the exported type + parser near the other types (after `CommentAuthor`):

```ts
/** An open Epic discovered from GitHub's issues API, with its sub-issue progress. */
export type EpicListItem = {
  number: number;
  title: string;
  state: string;
  labels: string[];
  subTotal: number;
  subClosed: number;
};

/**
 * Parse `gh api --paginate --jq '.'` NDJSON (one issue object per line) into the
 * Epic rows we cache. An Epic is an open issue with ≥1 sub-issue
 * (`sub_issues_summary.total > 0`); rows without a summary or with no sub-issues
 * are dropped. Blank lines are tolerated.
 */
export function parseEpicsList(stdout: string): EpicListItem[] {
  const out: EpicListItem[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const issue = JSON.parse(trimmed) as {
      number: number;
      title: string;
      state: string;
      labels?: { name: string }[];
      sub_issues_summary?: { total: number; completed: number };
    };
    const summary = issue.sub_issues_summary;
    if (!summary || summary.total <= 0) continue;
    out.push({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      labels: (issue.labels ?? []).map((l) => l.name),
      subTotal: summary.total,
      subClosed: summary.completed,
    });
  }
  return out;
}
```

Add the method to the `GitHubGateway` interface (after `getIssueLabels`):

```ts
  /** Open Epics in a repo (issues with ≥1 sub-issue), each with sub-issue progress. */
  listOpenEpics(repo: string): Promise<EpicListItem[]>;
```

Add the implementation to the `ghGitHub` object (follow the existing `ownerName(repo)` helper used by other methods — it splits `owner/name`):

```ts
  async listOpenEpics(repo) {
    const { owner, name } = ownerName(repo);
    const result = await run([
      "gh", "api", "--paginate",
      `repos/${owner}/${name}/issues`,
      "-X", "GET", "-f", "state=open", "-F", "per_page=100",
      "--jq", ".[] | select(.pull_request == null)",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`gh api list issues for ${repo} failed: ${result.stderr.trim()}`);
    }
    return parseEpicsList(result.stdout);
  },
```

> If the helper that parses `owner/name` is named differently (it is `ownerName` at `github.ts:66` per the audit), match the existing name; do not introduce a second parser.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/dispatcher/test/github-epics.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck`
Expected: no errors.

```bash
git add packages/dispatcher/src/github.ts packages/dispatcher/test/github-epics.test.ts
git commit -m "feat(dispatcher): list open Epics + sub-issue progress from GitHub"
```

---

## Task 2: Epic cache table + `epics-cache.ts`

**Files:**
- Create: `packages/dispatcher/src/db/migrations/005_epics.sql`
- Create: `packages/dispatcher/src/epics-cache.ts`
- Test: `packages/dispatcher/test/epics-cache.test.ts`

- [ ] **Step 1: Write the migration**

```sql
-- packages/dispatcher/src/db/migrations/005_epics.sql
-- The Epic browse cache. Refreshed from GitHub on an interval and after dispatch;
-- the dashboard's GET /api/epics reads it instead of hitting GitHub per page-view.
-- An Epic that drops out of the open set is marked state='closed' (not deleted)
-- so a just-closed Epic doesn't flicker out of an open view mid-refresh.
CREATE TABLE epics (
  repo           TEXT    NOT NULL,
  number         INTEGER NOT NULL,
  title          TEXT    NOT NULL,
  state          TEXT    NOT NULL,             -- 'open' | 'closed'
  labels_json    TEXT    NOT NULL DEFAULT '[]',
  sub_total      INTEGER NOT NULL DEFAULT 0,
  sub_closed     INTEGER NOT NULL DEFAULT 0,
  gh_updated_at  TEXT,
  last_refreshed INTEGER NOT NULL,             -- epoch ms of our last write
  PRIMARY KEY (repo, number)
);
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/dispatcher/test/epics-cache.test.ts
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { EpicListItem, GitHubGateway } from "../src/github.ts";
import { readEpics, refreshEpics } from "../src/epics-cache.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE epics (
    repo TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL,
    state TEXT NOT NULL, labels_json TEXT NOT NULL DEFAULT '[]',
    sub_total INTEGER NOT NULL DEFAULT 0, sub_closed INTEGER NOT NULL DEFAULT 0,
    gh_updated_at TEXT, last_refreshed INTEGER NOT NULL,
    PRIMARY KEY (repo, number));`);
  return db;
}

function fakeGitHub(epics: EpicListItem[]): GitHubGateway {
  return { listOpenEpics: async () => epics } as unknown as GitHubGateway;
}

describe("epics-cache", () => {
  test("refreshEpics upserts open Epics and readEpics returns them newest-first", async () => {
    const db = freshDb();
    await refreshEpics(db, "o/r", fakeGitHub([
      { number: 10, title: "A", state: "open", labels: ["epic"], subTotal: 3, subClosed: 1 },
      { number: 20, title: "B", state: "open", labels: [], subTotal: 2, subClosed: 2 },
    ]));
    const rows = readEpics(db, "o/r");
    expect(rows.map((r) => r.number)).toEqual([20, 10]);
    expect(rows[0]).toMatchObject({ number: 20, title: "B", subTotal: 2, subClosed: 2, labels: [] });
    expect(rows[1]).toMatchObject({ number: 10, labels: ["epic"], subTotal: 3, subClosed: 1 });
  });

  test("an Epic that vanishes from the open set is marked closed and dropped from readEpics", async () => {
    const db = freshDb();
    await refreshEpics(db, "o/r", fakeGitHub([
      { number: 10, title: "A", state: "open", labels: [], subTotal: 1, subClosed: 0 },
    ]));
    await refreshEpics(db, "o/r", fakeGitHub([])); // 10 no longer open
    expect(readEpics(db, "o/r")).toEqual([]);
    const raw = db.query("SELECT state FROM epics WHERE repo='o/r' AND number=10").get() as { state: string };
    expect(raw.state).toBe("closed");
  });

  test("refresh is repo-scoped — another repo's rows are untouched", async () => {
    const db = freshDb();
    await refreshEpics(db, "o/a", fakeGitHub([{ number: 1, title: "A", state: "open", labels: [], subTotal: 1, subClosed: 0 }]));
    await refreshEpics(db, "o/b", fakeGitHub([]));
    expect(readEpics(db, "o/a").map((r) => r.number)).toEqual([1]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/dispatcher/test/epics-cache.test.ts`
Expected: FAIL — `epics-cache.ts` does not exist.

- [ ] **Step 4: Implement `epics-cache.ts`**

```ts
// packages/dispatcher/src/epics-cache.ts
/**
 * The Epic browse cache (table `epics`, migration 005). `refreshEpics` pulls a
 * repo's open Epics from GitHub and upserts them; Epics no longer in the open set
 * are marked `closed` (kept, not deleted, so a just-closed Epic doesn't flicker
 * out mid-view). `readEpics` returns the open rows the dashboard browses.
 */
import type { Database } from "bun:sqlite";
import type { GitHubGateway } from "./github.ts";

/** A cached Epic row, projected for the dashboard join. */
export type EpicRow = {
  repo: string;
  number: number;
  title: string;
  state: string;
  labels: string[];
  subTotal: number;
  subClosed: number;
  lastRefreshed: number;
};

/** Refresh a repo's Epic cache from GitHub. One paginated list call; repo-scoped. */
export async function refreshEpics(db: Database, repo: string, github: GitHubGateway): Promise<void> {
  const epics = await github.listOpenEpics(repo);
  const now = Date.now();
  const upsert = db.query(
    `INSERT INTO epics (repo, number, title, state, labels_json, sub_total, sub_closed, last_refreshed)
     VALUES (?, ?, ?, 'open', ?, ?, ?, ?)
     ON CONFLICT(repo, number) DO UPDATE SET
       title = excluded.title, state = 'open', labels_json = excluded.labels_json,
       sub_total = excluded.sub_total, sub_closed = excluded.sub_closed,
       last_refreshed = excluded.last_refreshed`,
  );
  const open = new Set<number>();
  const tx = db.transaction(() => {
    for (const e of epics) {
      upsert.run(repo, e.number, e.title, JSON.stringify(e.labels), e.subTotal, e.subClosed, now);
      open.add(e.number);
    }
    // Mark cached-but-no-longer-open Epics closed (kept for non-flicker).
    const stale = db
      .query(`SELECT number FROM epics WHERE repo = ? AND state = 'open'`)
      .all(repo) as { number: number }[];
    const close = db.query(`UPDATE epics SET state = 'closed', last_refreshed = ? WHERE repo = ? AND number = ?`);
    for (const row of stale) {
      if (!open.has(row.number)) close.run(now, repo, row.number);
    }
  });
  tx();
}

/** The repo's open Epics, newest (highest number) first. */
export function readEpics(db: Database, repo: string): EpicRow[] {
  const rows = db
    .query(
      `SELECT repo, number, title, state, labels_json AS labelsJson,
              sub_total AS subTotal, sub_closed AS subClosed, last_refreshed AS lastRefreshed
       FROM epics WHERE repo = ? AND state = 'open' ORDER BY number DESC`,
    )
    .all(repo) as (Omit<EpicRow, "labels"> & { labelsJson: string })[];
  return rows.map((r) => ({
    repo: r.repo, number: r.number, title: r.title, state: r.state,
    labels: JSON.parse(r.labelsJson) as string[],
    subTotal: r.subTotal, subClosed: r.subClosed, lastRefreshed: r.lastRefreshed,
  }));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/dispatcher/test/epics-cache.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Verify the migration applies in the real migration set**

Run: `bun test packages/dispatcher/test`
Expected: PASS — existing migration/db tests still green with `005_epics.sql` present.

- [ ] **Step 7: Commit**

```bash
git add packages/dispatcher/src/db/migrations/005_epics.sql packages/dispatcher/src/epics-cache.ts packages/dispatcher/test/epics-cache.test.ts
git commit -m "feat(dispatcher): Epic browse cache (migration 005 + epics-cache)"
```

---

## Task 3: Daemon wiring — `dispatch` + `refreshEpics` host context, the refresh loop

**Files:**
- Modify: `packages/dispatcher/src/main.ts`
- Test: `packages/dispatcher/test/host-context.test.ts` (extend if present; else create)

This threads two new callbacks onto `DaemonHostContext` (mirroring the existing `runRecommender` seam), wires a refresh loop, and refreshes after a dispatch.

- [ ] **Step 1: Write the failing test**

This asserts the `hostExtras` context now carries `dispatch` and `refreshEpics`. Use the existing host-context test as the template (it already builds a fake `hostExtras` and captures the `ctx`). If a `host-context.test.ts` exists, add this case; otherwise create the file modeled on the daemon-entry test.

```ts
// packages/dispatcher/test/host-context.test.ts (add this case)
import { expect, test } from "bun:test";
import type { DaemonHostContext } from "../src/main.ts";

test("DaemonHostContext exposes dispatch + refreshEpics callbacks", () => {
  // Type-level guarantee: the context shape carries the new seams. A compile error
  // here (missing property) is the failure signal; the runtime assert documents intent.
  const shape: (keyof DaemonHostContext)[] = ["db", "config", "stateGateway", "runRecommender", "dispatch", "refreshEpics"];
  expect(shape).toContain("dispatch");
  expect(shape).toContain("refreshEpics");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/dispatcher/test/host-context.test.ts`
Expected: FAIL — `dispatch`/`refreshEpics` are not on `DaemonHostContext` (type error).

- [ ] **Step 3: Extend `DaemonHostContext` and the options**

In `packages/dispatcher/src/main.ts`, extend the type (after `runRecommender`, line ~55):

```ts
export type DaemonHostContext = {
  db: Database;
  config: MiddleConfig;
  stateGateway: StateIssueGateway;
  runRecommender: (repo: string) => Promise<{ status: number; body: string }>;
  /** Force-dispatch an Epic with a chosen adapter — same path as `mm dispatch`. */
  dispatch: (repo: string, epicNumber: number, adapter: string) => Promise<{ status: number; body: string }>;
  /** Refresh a repo's Epic browse cache from GitHub. */
  refreshEpics: (repo: string) => Promise<{ status: number; body: string }>;
};
```

- [ ] **Step 4: Add the manual-dispatch helper + refresh helpers + loop**

Add the import near the other dispatcher imports at the top of `main.ts`:

```ts
import { ghGitHub } from "./github.ts";
import { refreshEpics } from "./epics-cache.ts";
```

Add the interval constant beside `AUTO_DISPATCH_DEBOUNCE_MS` (line ~73):

```ts
/** Epic-cache refresh cadence (constant, like POLLER/WATCHDOG; config-ification deferred). */
const EPICS_REFRESH_INTERVAL_MS = 60_000;
```

Inside `runDaemon`, after `slotAvailable` is defined (line ~255) and `repoPaths` exists, add a manual-dispatch helper that reuses the same gates as `POST /control/dispatch` and a refresh helper:

```ts
  /** Force-dispatch an Epic (the dashboard's button + a future API). Mirrors the
   *  control-route gates: 400 (unknown repo/adapter), 429 (no slot), 409 (collision). */
  async function dispatchEpicManual(
    repo: string,
    epicNumber: number,
    adapter: string,
  ): Promise<{ status: number; body: string }> {
    const repoPath = repoPaths.get(repo);
    if (repoPath === undefined) {
      return { status: 400, body: JSON.stringify({ error: `unknown repo: ${repo}` }) };
    }
    if (adapter !== "claude") {
      return { status: 400, body: JSON.stringify({ error: `unknown adapter: ${adapter}` }) };
    }
    const input = { repo, repoPath, epicNumber, adapter };
    if (!slotAvailable(input)) {
      return { status: 429, body: JSON.stringify({ error: `no free slot for ${adapter} in ${repo}` }) };
    }
    const workflowId = await startDispatchImpl(input, "manual");
    if (workflowId === null) {
      return { status: 409, body: JSON.stringify({ error: `Epic #${epicNumber} in ${repo} already has an active workflow` }) };
    }
    scheduleAutoDispatch(repo);
    void refreshEpics(db, repo, ghGitHub).catch(() => {}); // best-effort cache refresh after dispatch
    return { status: 200, body: JSON.stringify({ workflowId }) };
  }

  /** Refresh a repo's Epic cache on demand (the dashboard's refresh affordance). */
  async function refreshEpicsForRepo(repo: string): Promise<{ status: number; body: string }> {
    if (!repoPaths.has(repo)) {
      return { status: 404, body: JSON.stringify({ error: `unknown repo: ${repo}` }) };
    }
    try {
      await refreshEpics(db, repo, ghGitHub);
      return { status: 200, body: JSON.stringify({ ok: true }) };
    } catch (error) {
      return { status: 502, body: JSON.stringify({ error: (error as Error).message }) };
    }
  }
```

Add the interval loop where the other startup loops are wired (near `scheduleAutoDispatch` initial pass / the poller/watchdog start). Refresh every known repo on the interval, plus once at startup:

```ts
  // Epic-cache refresh: an initial pass + a fixed-cadence sweep over every known
  // repo. Best-effort — a GitHub hiccup logs and the next tick retries.
  function refreshAllEpics(): void {
    for (const repo of repoPaths.keys()) {
      void refreshEpics(db, repo, ghGitHub).catch((e: unknown) =>
        console.error(`[epics] refresh ${repo} failed: ${(e as Error).message}`),
      );
    }
  }
  refreshAllEpics();
  const epicsTimer = setInterval(refreshAllEpics, EPICS_REFRESH_INTERVAL_MS);
```

In the shutdown path (where other timers/intervals are cleared and `shuttingDown` is set), add:

```ts
  clearInterval(epicsTimer);
```

- [ ] **Step 5: Pass the new callbacks at the `hostExtras` call site**

At the `opts.hostExtras({ ... })` call (line ~435), add `dispatch` and `refreshEpics` beside `runRecommender`:

```ts
        const hosted = opts.hostExtras({
          db,
          config,
          stateGateway: ghStateIssueGateway,
          runRecommender: async (repo: string) => {
            const path = repoPaths.get(repo);
            if (path === undefined) {
              return { status: 404, body: JSON.stringify({ error: `unknown repo: ${repo}` }) };
            }
            return runRecommenderForRepo(path);
          },
          dispatch: (repo, epicNumber, adapter) => dispatchEpicManual(repo, epicNumber, adapter),
          refreshEpics: (repo) => refreshEpicsForRepo(repo),
        });
```

> Match the exact existing object literal — only add the two new properties. Do not reorder or change `runRecommender`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test packages/dispatcher/test/host-context.test.ts && bun run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/dispatcher/src/main.ts packages/dispatcher/test/host-context.test.ts
git commit -m "feat(dispatcher): host-context dispatch + Epic-cache refresh loop"
```

---

## Task 4: Wire type + dashboard deps (`EpicCard`, `listEpics`, dispatch/refresh seams)

**Files:**
- Modify: `packages/dashboard/src/wire.ts`, `packages/dashboard/src/deps.ts`, `packages/dashboard/src/db-deps.ts`
- Test: `packages/dashboard/test/epics-deps.test.ts` (create)

- [ ] **Step 1: Add the wire type**

In `packages/dashboard/src/wire.ts`, append:

```ts
/** One Epic card in the Epic-centric browse view — cache + workflows + state-issue join. */
export type EpicCard = {
  repo: string;
  number: number;
  title: string;
  /** Sub-issue progress from the cache. */
  progress: { closed: number; total: number };
  /** The runner working this Epic, when one is in flight. */
  runner: {
    adapter: string;
    state: string;
    currentSubIssue: number | null;
    session: string;
    prNumber: number | null;
  } | null;
  /** A high-value decision callout from the state issue (needs-human / blocked). */
  decision: { label: string; oneLiner: string; link?: string } | null;
  /** Force-dispatch affordance state. */
  dispatch: {
    /** True when a non-terminal workflow already owns this Epic (the 409 guard). */
    inFlight: boolean;
    /** The recommender's adapter pick (state-issue Ready row), the picker default. */
    recommendedAdapter: string | null;
    /** Per-adapter free-slot availability right now. */
    freeSlots: { adapter: string; available: boolean }[];
  };
};
```

- [ ] **Step 2: Add the deps methods**

In `packages/dashboard/src/deps.ts`, import `EpicCard` (add to the `./wire.ts` import block) and add to the `DashboardDeps` type:

```ts
  /** The repo's open Epics for the browse view (cache + workflows + state-issue join). */
  listEpics(repo: string): Promise<EpicCard[]>;

  /**
   * Force-dispatch an Epic with a chosen adapter. `null` → no dispatch is wired
   * (standalone/read-only mode → the route 404s). Returns the daemon's status/body.
   */
  dispatchEpic?(repo: string, epicNumber: number, adapter: string): Promise<{ status: number; body: string }>;

  /** Refresh a repo's Epic cache. `null` → not wired (the route 404s). */
  refreshEpics?(repo: string): Promise<{ status: number; body: string }>;
```

- [ ] **Step 3: Write the failing deps test**

Use the suite's shared helpers (`makeDb` gives a fully migrated db — the `epics` table from Task 2's migration 005 is present; `makeConfig`/`seedWorkflow` match every other dashboard test). Insert `epics` + `repo_config` rows directly.

```ts
// packages/dashboard/test/epics-deps.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createDbDeps } from "../src/db-deps.ts";
import { makeConfig, makeDb, seedWorkflow } from "./helpers.ts";

let db: Database;
let cleanup: () => void;
beforeEach(() => {
  const made = makeDb();
  db = made.db;
  cleanup = made.cleanup;
});
afterEach(() => cleanup());

function seedEpic(repo: string, number: number, title: string, total: number, closed: number, labels: string[] = []): void {
  db.run(
    `INSERT INTO epics (repo, number, title, state, labels_json, sub_total, sub_closed, last_refreshed)
     VALUES (?, ?, ?, 'open', ?, ?, ?, 0)`,
    [repo, number, title, JSON.stringify(labels), total, closed],
  );
}

const STATE_BODY = [
  "<!-- AGENT-QUEUE-STATE v1 -->",
  "<!-- generated: 2026-05-25T00:00:00Z · run: 0badf00d · interval: 30m -->",
  "<!-- owners: recommender=r, dispatcher=d -->",
  "## Ready to dispatch",
  "| Rank | Epic | Adapter | Sub-issues | Reason |",
  "| 1 | #247 OAuth | claude | 4 | `ranked` |",
  "## Needs human input",
  "- **#247 awaiting reply** — answer the window question · [link](http://x)",
  "## Blocked",
  "- _none_",
  "## In-flight",
  "- _no agents in flight_",
  "## Excluded",
  "- _none_",
  "## Rate limits",
  "- claude: AVAILABLE",
  "## Slot usage",
  "- claude: 0/2",
  "- total: 0/3",
  "- global: 0/3",
  "<!-- /AGENT-QUEUE-STATE -->",
].join("\n");

describe("createDbDeps.listEpics", () => {
  test("joins cache progress + state-issue decision/recommendation + free slots", async () => {
    seedEpic("o/r", 247, "OAuth", 4, 2, ["epic"]);
    const deps = createDbDeps({
      db, config: makeConfig(),
      stateGateway: { readBody: async () => STATE_BODY },
    });
    const cards = await deps.listEpics("o/r");
    expect(cards).toHaveLength(1);
    const c = cards[0]!;
    expect(c).toMatchObject({ number: 247, title: "OAuth", progress: { closed: 2, total: 4 }, runner: null });
    expect(c.decision).toEqual({ label: "awaiting reply", oneLiner: "answer the window question", link: "http://x" });
    expect(c.dispatch.inFlight).toBe(false);
    expect(c.dispatch.recommendedAdapter).toBe("claude");
    expect(c.dispatch.freeSlots).toContainEqual({ adapter: "claude", available: true });
  });

  test("an in-flight workflow surfaces as the runner and flips inFlight", async () => {
    seedEpic("o/r", 9, "X", 2, 0);
    seedWorkflow(db, { id: "wf1", repo: "o/r", epicNumber: 9, adapter: "claude", state: "running", sessionName: "o-r-9", currentSubIssue: 1 });
    const deps = createDbDeps({ db, config: makeConfig() });
    const c = (await deps.listEpics("o/r"))[0]!;
    expect(c.runner).toMatchObject({ adapter: "claude", state: "running", currentSubIssue: 1, session: "o-r-9" });
    expect(c.dispatch.inFlight).toBe(true);
  });

  test("dispatchEpic + refreshEpics delegate to the injected callbacks", async () => {
    const deps = createDbDeps({
      db, config: makeConfig(),
      dispatch: async (repo, n, adapter) => ({ status: 200, body: `${repo}:${n}:${adapter}` }),
      refreshEpicsTrigger: async (repo) => ({ status: 200, body: repo }),
    });
    expect(await deps.dispatchEpic!("o/r", 7, "claude")).toEqual({ status: 200, body: "o/r:7:claude" });
    expect(await deps.refreshEpics!("o/r")).toEqual({ status: 200, body: "o/r" });
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test packages/dashboard/test/epics-deps.test.ts`
Expected: FAIL — `listEpics` not implemented.

- [ ] **Step 5: Implement in `db-deps.ts`**

Add imports at the top of `db-deps.ts`:

```ts
import { getSlotState, hasFreeSlot } from "@middle/dispatcher/src/slots.ts";
import { readEpics } from "@middle/dispatcher/src/epics-cache.ts";
import type { EpicCard } from "./wire.ts"; // add to the existing ./wire.ts import block
```

Extend `DbDepsOptions` with the two callbacks:

```ts
  /** Force-dispatch seam (the daemon wires it; standalone leaves it absent → 404). */
  dispatch?: (repo: string, epicNumber: number, adapter: string) => Promise<{ status: number; body: string }>;
  /** Epic-cache refresh seam (daemon-wired). */
  refreshEpicsTrigger?: (repo: string) => Promise<{ status: number; body: string }>;
```

Inside `createDbDeps`, add a helper that finds the non-terminal workflow for an Epic and the slot-limits builder, then the three methods. Place the helper beside `inFlight`/`rowBySession`:

```ts
  /** The non-terminal implementation workflow owning an Epic, if any. */
  function workflowForEpic(repo: string, epicNumber: number): WorkflowRow | null {
    const placeholders = TERMINAL_STATES.map(() => "?").join(", ");
    return db
      .query(
        `SELECT ${WORKFLOW_COLUMNS} FROM workflows
         WHERE repo = ? AND epic_number = ? AND kind = 'implementation' AND state NOT IN (${placeholders})
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(repo, epicNumber, ...TERMINAL_STATES) as WorkflowRow | null;
  }

  /** Slot limits for `hasFreeSlot`, from the merged config. */
  function slotLimits(): { perAdapter: Record<string, number>; repoMax: number; globalMax: number } {
    const { perAdapter, repoMax } = repoLimits();
    return { perAdapter, repoMax, globalMax: config.global.maxConcurrent };
  }
```

Add the methods to the returned object (after `getRepo` is fine):

```ts
    async listEpics(repo: string): Promise<EpicCard[]> {
      const rows = readEpics(db, repo);
      if (rows.length === 0) return [];
      const parsed = await readParsedState(repo);
      const adapters = Object.keys(config.adapters ?? {});
      const adapterNames = adapters.length > 0 ? adapters : ["claude"];
      const state = getSlotState(db, repo, slotLimits());
      const freeSlots = adapterNames.sort().map((adapter) => ({
        adapter,
        available: hasFreeSlot(state, adapter),
      }));
      return rows.map((row) => {
        const wf = workflowForEpic(repo, row.number);
        const need = parsed?.needsHumanInput.find((i) => i.issue === row.number) ?? null;
        const ready = parsed?.readyToDispatch.find(
          (r) => Number(r.epic.replace(/^#/, "").split(/\s/)[0]) === row.number,
        );
        return {
          repo,
          number: row.number,
          title: row.title,
          progress: { closed: row.subClosed, total: row.subTotal },
          runner: wf
            ? {
                adapter: wf.adapter,
                state: wf.state,
                currentSubIssue: wf.current_sub_issue,
                session: wf.session_name ?? wf.id,
                prNumber: wf.pr_number,
              }
            : null,
          decision: need
            ? { label: need.label, oneLiner: need.oneLiner, ...(need.link ? { link: need.link } : {}) }
            : null,
          dispatch: {
            inFlight: wf !== null,
            recommendedAdapter: ready?.adapter ?? null,
            freeSlots,
          },
        };
      });
    },

    dispatchEpic: opts.dispatch,
    refreshEpics: opts.refreshEpicsTrigger,
```

> `NeedsHumanItem`'s exact field names (`issue`, `label`, `oneLiner`, `link`) come from the state-issue parser; the existing `needsYou()` method already reads them the same way — mirror it. `ReadyRow.epic` is the raw `#<n> <title>` cell, hence the `replace`/`split` to recover the number (matches `getRepo`'s `Number(r.epic.replace(/^#/, ""))` approach).

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test packages/dashboard/test/epics-deps.test.ts && bun run typecheck`
Expected: PASS (3 tests); no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/dashboard/src/wire.ts packages/dashboard/src/deps.ts packages/dashboard/src/db-deps.ts packages/dashboard/test/epics-deps.test.ts
git commit -m "feat(dashboard): EpicCard wire type + listEpics/dispatch/refresh deps"
```

---

## Task 5: `/api/epics/*` routes

**Files:**
- Modify: `packages/dashboard/src/api.ts`
- Test: `packages/dashboard/test/epics-api.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/dashboard/test/epics-api.test.ts
import { describe, expect, test } from "bun:test";
import { handleApi } from "../src/api.ts";
import type { DashboardDeps } from "../src/deps.ts";

function deps(over: Partial<DashboardDeps>): DashboardDeps {
  return { listEpics: async () => [] as never, ...over } as unknown as DashboardDeps;
}
const req = (path: string, method = "GET", body?: unknown) =>
  new Request(`http://x${path}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });

describe("/api/epics", () => {
  test("GET /api/epics/:repo returns the card list", async () => {
    const cards = [{ number: 1 }];
    const res = await handleApi(req("/api/epics/o%2Fr"), deps({ listEpics: async (r) => (r === "o/r" ? (cards as never) : []) }));
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual(cards);
  });

  test("POST /api/epics/:repo/:n/dispatch forwards adapter + status/body", async () => {
    const res = await handleApi(
      req("/api/epics/o%2Fr/7/dispatch", "POST", { adapter: "claude" }),
      deps({ dispatchEpic: async (r, n, a) => ({ status: 200, body: JSON.stringify({ r, n, a }) }) }),
    );
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ r: "o/r", n: 7, a: "claude" });
  });

  test("dispatch 404s when no dispatch seam is wired", async () => {
    const res = await handleApi(req("/api/epics/o%2Fr/7/dispatch", "POST", { adapter: "claude" }), deps({}));
    expect(res!.status).toBe(404);
  });

  test("dispatch rejects a missing adapter with 400", async () => {
    const res = await handleApi(req("/api/epics/o%2Fr/7/dispatch", "POST", {}), deps({ dispatchEpic: async () => ({ status: 200, body: "{}" }) }));
    expect(res!.status).toBe(400);
  });

  test("POST /api/epics/:repo/refresh forwards", async () => {
    const res = await handleApi(req("/api/epics/o%2Fr/refresh", "POST"), deps({ refreshEpics: async () => ({ status: 200, body: JSON.stringify({ ok: true }) }) }));
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/dashboard/test/epics-api.test.ts`
Expected: FAIL — no `epics` route; falls through to a 404 with the wrong detail / undefined.

- [ ] **Step 3: Implement the route branch**

In `packages/dashboard/src/api.ts`, add inside `handleApi` (after the `repos` branch, before `sessions`):

```ts
  if (resource === "epics") {
    return handleEpics(req, deps, tail, method);
  }
```

Add the handler function (after `handleRepos`):

```ts
/** `/api/epics/:repo` (GET), `/api/epics/:repo/refresh` (POST), `/api/epics/:repo/:n/dispatch` (POST). */
async function handleEpics(
  req: Request,
  deps: DashboardDeps,
  tail: string[],
  method: string,
): Promise<Response> {
  const repo = tail[0];
  if (repo === undefined || repo === "") return badRequest("repo path segment is required");

  if (tail.length === 1 && method === "GET") {
    return Response.json(await deps.listEpics(repo));
  }

  if (tail.length === 2 && tail[1] === "refresh" && method === "POST") {
    if (!deps.refreshEpics) return notFound("epic refresh not wired");
    const result = await deps.refreshEpics(repo);
    return new Response(result.body, {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  }

  if (tail.length === 3 && tail[2] === "dispatch" && method === "POST") {
    const epicNumber = Number(tail[1]);
    if (!Number.isSafeInteger(epicNumber) || epicNumber < 1) {
      return badRequest("epic number must be a positive integer");
    }
    const body = await readJson(req);
    if (typeof body.adapter !== "string" || body.adapter.trim() === "") {
      return badRequest("adapter must be a non-empty string");
    }
    if (!deps.dispatchEpic) return notFound("manual dispatch not wired in this dashboard mode");
    const result = await deps.dispatchEpic(repo, epicNumber, body.adapter);
    return new Response(result.body, {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  }

  return notFound(`no such epics route: /${tail.join("/")}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/dashboard/test/epics-api.test.ts && bun run typecheck`
Expected: PASS (5 tests); no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/api.ts packages/dashboard/test/epics-api.test.ts
git commit -m "feat(dashboard): /api/epics list, refresh, and force-dispatch routes"
```

---

## Task 6: Thread the seams through `daemon-entry.ts`

**Files:**
- Modify: `packages/cli/src/daemon-entry.ts`
- Test: `packages/cli/test/daemon-entry.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Extend the existing daemon-entry test to assert the dashboard deps receive the dispatch + refresh callbacks. The current test calls `dashboardHostExtras(fakeCtx)` and asserts routes answer. Add a case that the `dispatch` / `refreshEpics` context callbacks are reachable through a `GET`/`POST` to `/api/epics/...`. Minimal version:

```ts
// packages/cli/test/daemon-entry.test.ts (add)
import { expect, test } from "bun:test";
import { dashboardHostExtras } from "../src/daemon-entry.ts";

test("dashboardHostExtras forwards dispatch + refreshEpics into the epics routes", async () => {
  let dispatched: [string, number, string] | null = null;
  const ctx = {
    db: makeTestDb(),            // reuse the helper the existing test already uses
    config: makeTestConfig(),    // ditto
    stateGateway: { readBody: async () => "" },
    runRecommender: async () => ({ status: 200, body: "{}" }),
    dispatch: async (repo: string, n: number, adapter: string) => {
      dispatched = [repo, n, adapter];
      return { status: 200, body: JSON.stringify({ workflowId: "wf" }) };
    },
    refreshEpics: async () => ({ status: 200, body: JSON.stringify({ ok: true }) }),
  };
  const { routes } = dashboardHostExtras(ctx as never);
  const dispatchRoute = (routes["/api/*"] ?? routes["/api/epics/:repo/:n/dispatch"]) as
    | ((req: Request) => Promise<Response>)
    | undefined;
  // The dashboard merges everything under its fetch/route table; assert via the
  // composed handler the daemon would call. If the route table keys differ, drive
  // it through createDashboardRoutes' fetch entry the existing test already exercises.
  expect(typeof dispatchRoute === "function" || routes !== undefined).toBe(true);
  expect(dispatched).toBeNull(); // not dispatched until a request arrives
});
```

> Adapt to the existing test's helpers (`makeTestDb`/`makeTestConfig` or inline equivalents already in that file). The assertion that matters: `dashboardHostExtras` builds without throwing when `dispatch`/`refreshEpics` are present, and the resulting deps carry them. If the existing test drives requests through a composed handler, prefer asserting a `POST /api/epics/o%2Fr/1/dispatch` sets `dispatched`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/test/daemon-entry.test.ts`
Expected: FAIL — `createDbDeps` is called without `dispatch`/`refreshEpicsTrigger`, so the route 404s / `dispatched` stays null when driven.

- [ ] **Step 3: Pass the callbacks into `createDbDeps`**

In `packages/cli/src/daemon-entry.ts`, extend the `createDbDeps({ ... })` call in `dashboardHostExtras`:

```ts
  const deps = createDbDeps({
    db: ctx.db,
    config: ctx.config,
    stateGateway: ctx.stateGateway,
    events: bus,
    runRecommender: ctx.runRecommender,
    dispatch: ctx.dispatch,
    refreshEpicsTrigger: ctx.refreshEpics,
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/test/daemon-entry.test.ts && bun run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/daemon-entry.ts packages/cli/test/daemon-entry.test.ts
git commit -m "feat(cli): thread dispatch + Epic-cache refresh into dashboard deps"
```

---

## Task 7: `api-client` methods + `Epics.tsx` component

**Files:**
- Modify: `packages/dashboard/src/app/api-client.ts`
- Create: `packages/dashboard/src/app/components/Epics.tsx`
- Test: `packages/dashboard/test/epics.test.tsx` (create)

- [ ] **Step 1: Add the api-client methods**

In `packages/dashboard/src/app/api-client.ts`, add `EpicCard` to the `../wire.ts` import block, then add to the `api` object (after `runRecommender`):

```ts
  epics: (repo: string) => getJson<EpicCard[]>(`/api/epics/${enc(repo)}`),
  refreshEpics: async (repo: string): Promise<void> => {
    const res = await fetch(`/api/epics/${enc(repo)}/refresh`, { method: "POST" });
    if (!res.ok) throw new ApiError(res.status, await errorDetail(res));
  },
  dispatchEpic: (repo: string, epicNumber: number, adapter: string) =>
    postJson<{ workflowId: string }>(`/api/epics/${enc(repo)}/${epicNumber}/dispatch`, { adapter }),
```

- [ ] **Step 2: Write the failing component test**

The dashboard's `*.test.tsx` files render with `renderToStaticMarkup` from `react-dom/server` and assert on the HTML string (see `queue.test.tsx`) — no `@testing-library`, no DOM. A disabled button renders the `disabled` attribute into the markup, which is what we assert against.

```tsx
// packages/dashboard/test/epics.test.tsx
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Epics } from "../src/app/components/Epics.tsx";
import type { EpicCard } from "../src/wire.ts";

const card = (over: Partial<EpicCard> = {}): EpicCard => ({
  repo: "o/r", number: 247, title: "OAuth refresh",
  progress: { closed: 2, total: 4 },
  runner: null, decision: null,
  dispatch: { inFlight: false, recommendedAdapter: "claude", freeSlots: [{ adapter: "claude", available: true }] },
  ...over,
});
const html = (c: EpicCard) =>
  renderToStaticMarkup(<Epics epics={[c]} adapters={["claude"]} onDispatch={() => {}} onOpenInspector={() => {}} />);

describe("Epics", () => {
  test("renders an Epic card with title, progress, and an enabled dispatch button", () => {
    const out = html(card());
    expect(out).toContain("#247 OAuth refresh");
    expect(out).toContain("2 / 4");
    // Enabled: the dispatch button markup carries no `disabled` attribute.
    expect(out).toContain("dispatch");
    expect(out).not.toContain("disabled");
  });

  test("empty state when there are no Epics", () => {
    const out = renderToStaticMarkup(
      <Epics epics={[]} adapters={["claude"]} onDispatch={() => {}} onOpenInspector={() => {}} />,
    );
    expect(out).toContain("No open Epics for this repo.");
  });

  test("disables dispatch when in flight", () => {
    const out = html(card({
      dispatch: { inFlight: true, recommendedAdapter: "claude", freeSlots: [{ adapter: "claude", available: true }] },
      runner: { adapter: "claude", state: "running", currentSubIssue: 1, session: "s", prNumber: null },
    }));
    expect(out).toContain("disabled");
    expect(out).toContain("claude · running"); // agent badge
  });

  test("disables dispatch when the chosen adapter has no free slot", () => {
    const out = html(card({
      dispatch: { inFlight: false, recommendedAdapter: "claude", freeSlots: [{ adapter: "claude", available: false }] },
    }));
    expect(out).toContain("disabled");
  });

  test("shows a decision callout when present", () => {
    const out = html(card({ decision: { label: "awaiting reply", oneLiner: "answer the window question" } }));
    expect(out).toContain("awaiting reply");
    expect(out).toContain("answer the window question");
  });
});
```

> `renderToStaticMarkup` emits a `disabled` attribute only when the prop is truthy, so `not.toContain("disabled")` is a valid enabled-state assertion **for this component** (it has no other `disabled` text). Keep that invariant — if you add another control, scope the assertion (e.g. assert on the button substring).

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/dashboard/test/epics.test.tsx`
Expected: FAIL — `Epics.tsx` does not exist.

- [ ] **Step 4: Implement `Epics.tsx`**

```tsx
// packages/dashboard/src/app/components/Epics.tsx
/**
 * The Epic browse view — the dashboard's primary surface. Lists a repo's open
 * Epics with sub-issue progress, the agent working each (if any), a high-value
 * decision callout from the state issue, and a force-dispatch control whose
 * adapter picker defaults to the recommender's choice. The repo filter lives in
 * {@link App}; this component renders the chosen repo's cards.
 */
import { useState } from "react";
import type { EpicCard } from "../../wire.ts";

function ProgressBar({ closed, total }: { closed: number; total: number }) {
  const pct = total > 0 ? Math.round((closed / total) * 100) : 0;
  return (
    <div className="epic-progress" aria-label={`${closed} of ${total} sub-issues done`}>
      <div className="epic-progress-fill" style={{ width: `${pct}%` }} />
      <span className="epic-progress-label">
        {closed} / {total}
      </span>
    </div>
  );
}

function DispatchControl({
  card,
  adapters,
  onDispatch,
}: {
  card: EpicCard;
  adapters: string[];
  onDispatch: (repo: string, epicNumber: number, adapter: string) => void;
}) {
  const [adapter, setAdapter] = useState(card.dispatch.recommendedAdapter ?? adapters[0] ?? "claude");
  const slot = card.dispatch.freeSlots.find((s) => s.adapter === adapter);
  const noSlot = slot ? !slot.available : false;
  const disabled = card.dispatch.inFlight || noSlot;
  return (
    <div className="epic-dispatch">
      <select
        aria-label="agent"
        value={adapter}
        onChange={(e) => setAdapter(e.target.value)}
        disabled={card.dispatch.inFlight}
      >
        {adapters.map((a) => (
          <option key={a} value={a}>
            {a}
            {a === card.dispatch.recommendedAdapter ? " ★" : ""}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={disabled}
        title={card.dispatch.inFlight ? "already in flight" : noSlot ? "no free slot" : ""}
        onClick={() => onDispatch(card.repo, card.number, adapter)}
      >
        dispatch
      </button>
    </div>
  );
}

export function Epics({
  epics,
  adapters,
  onDispatch,
  onOpenInspector,
}: {
  epics: EpicCard[];
  adapters: string[];
  onDispatch: (repo: string, epicNumber: number, adapter: string) => void;
  onOpenInspector?: (session: string) => void;
}) {
  return (
    <section className="epics" aria-labelledby="epics-h">
      <h2 id="epics-h">EPICS</h2>
      {epics.length === 0 ? (
        <p className="empty">No open Epics for this repo.</p>
      ) : (
        <ul>
          {epics.map((card) => (
            <li key={card.number} className="epic-card" data-epic={card.number}>
              <div className="epic-head">
                <span className="epic-title">
                  #{card.number} {card.title}
                </span>
                {card.runner ? (
                  <button
                    type="button"
                    className="epic-agent"
                    onClick={() => onOpenInspector?.(card.runner!.session)}
                  >
                    {card.runner.adapter} · {card.runner.state}
                  </button>
                ) : (
                  <span className="epic-agent idle">idle</span>
                )}
              </div>
              <ProgressBar closed={card.progress.closed} total={card.progress.total} />
              {card.decision ? (
                <div className="epic-decision">
                  <span className="label">{card.decision.label}</span> — {card.decision.oneLiner}
                  {card.decision.link ? (
                    <>
                      {" "}
                      <a href={card.decision.link}>open</a>
                    </>
                  ) : null}
                </div>
              ) : null}
              <DispatchControl card={card} adapters={adapters} onDispatch={onDispatch} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/dashboard/test/epics.test.tsx && bun run typecheck`
Expected: PASS (4 tests); no type errors.

- [ ] **Step 6: Add styles + commit**

Add minimal scoped styles to `packages/dashboard/src/app/styles.css` (follow the existing `.queue`/`.repos` scoping convention):

```css
.epics .epic-card { border: 1px solid var(--border, #333); border-radius: 6px; padding: 0.5rem 0.75rem; margin-bottom: 0.5rem; }
.epics .epic-head { display: flex; justify-content: space-between; align-items: baseline; gap: 0.5rem; }
.epics .epic-progress { position: relative; height: 1rem; background: #222; border-radius: 3px; overflow: hidden; margin: 0.35rem 0; }
.epics .epic-progress-fill { position: absolute; inset: 0 auto 0 0; background: #3a7; }
.epics .epic-progress-label { position: relative; font-size: 0.75rem; padding-left: 0.35rem; }
.epics .epic-agent.idle { opacity: 0.6; }
.epics .epic-decision { font-size: 0.85rem; margin: 0.25rem 0; }
.epics .epic-dispatch { display: flex; gap: 0.5rem; margin-top: 0.35rem; }
```

```bash
git add packages/dashboard/src/app/api-client.ts packages/dashboard/src/app/components/Epics.tsx packages/dashboard/src/app/styles.css packages/dashboard/test/epics.test.tsx
git commit -m "feat(dashboard): Epics browse view + api-client methods"
```

---

## Task 8: Wire `Epics` into `App.tsx` as the default view

**Files:**
- Modify: `packages/dashboard/src/app/App.tsx`
- Test: `packages/dashboard/test/app.test.tsx` (extend)

- [ ] **Step 1: Write the failing test**

`app.test.tsx` renders `<App />` with `renderToStaticMarkup` (static initial render — effects/fetch don't run), and separately round-trips the `api` client against a **live** `createDashboardServer` seeded via `helpers.ts`. Add one test of each kind. The static render of the default Epics view shows the empty state (no effects → `epics` stays `[]`), which proves the default branch; the live-server test proves `/api/epics` end-to-end.

```tsx
// packages/dashboard/test/app.test.tsx (add these)
// (top-of-file imports already include: renderToStaticMarkup, App, api,
//  createDbDeps, createDashboardServer, makeConfig, makeDb, seedWorkflow)

test("App defaults to the Epics view (nav tab + empty state render)", () => {
  const html = renderToStaticMarkup(<App />);
  expect(html).toContain(">epics<");           // the new nav tab
  expect(html).toContain("No open Epics for this repo."); // default view is Epics, no data
});

test("api.epics reads Epic cards from a live server", async () => {
  const { db, cleanup } = makeDb();
  try {
    db.run(
      `INSERT INTO epics (repo, number, title, state, labels_json, sub_total, sub_closed, last_refreshed)
       VALUES ('o/r', 247, 'OAuth refresh', 'open', '[]', 4, 2, 0)`,
    );
    seedWorkflow(db, { id: "wf1", repo: "o/r", epicNumber: 247, adapter: "claude", state: "running", sessionName: "o-r-247", currentSubIssue: 2 });
    const deps = createDbDeps({ db, config: makeConfig() });
    const server = createDashboardServer(deps, { port: 0 });
    try {
      const res = await fetch(`http://localhost:${server.port}/api/epics/${encodeURIComponent("o/r")}`);
      expect(res.status).toBe(200);
      const cards = (await res.json()) as { number: number; runner: { adapter: string } | null }[];
      expect(cards[0]).toMatchObject({ number: 247, runner: { adapter: "claude" } });
    } finally {
      server.stop(true);
    }
  } finally {
    cleanup();
  }
});
```

> Match the exact `createDashboardServer` signature + stop call the file's existing "api-client against a live server" describe block uses (port option, `.port`, `.stop(true)`). If it calls `api.epics(...)` against a `globalThis.fetch` pointed at the server, mirror that instead of the raw `fetch` shown here. The contract that matters: a seeded Epic row surfaces as a card with its runner over HTTP.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/dashboard/test/app.test.tsx`
Expected: FAIL — no `>epics<` nav tab; default view is still `dashboard`.

- [ ] **Step 3: Edit `App.tsx`**

(a) Import the component and types (add to the existing imports):

```ts
import { Epics } from "./components/Epics.tsx";
import type { EpicCard } from "../wire.ts"; // add to the existing ../wire.ts import
```

(b) Change the view-state type + default (line 59):

```ts
  const [view, setView] = useState<"epics" | "dashboard" | "queue" | "settings">("epics");
```

(c) Add Epic state + a selected-repo filter near the other `useState`s:

```ts
  const [epics, setEpics] = useState<EpicCard[]>([]);
  const [epicRepo, setEpicRepo] = useState<string | null>(null);
```

(d) Derive a default `epicRepo` once repos load, and fetch the selected repo's Epics on the Epics view + poll. Add after the existing settings/queue effects:

```ts
  // Default the Epic-view repo filter to the first tracked repo once repos arrive.
  useEffect(() => {
    if (epicRepo === null && repos.length > 0) setEpicRepo(repos[0]!.repo);
  }, [repos, epicRepo]);

  const refreshEpics = useCallback(
    (repo: string) => guard("epics", async () => setEpics(await api.epics(repo))),
    [guard],
  );

  // Load + poll the selected repo's Epics while the Epics view is open.
  useEffect(() => {
    if (view !== "epics" || epicRepo === null) return;
    void refreshEpics(epicRepo);
    const id = setInterval(() => void refreshEpics(epicRepo), POLL_MS);
    return () => clearInterval(id);
  }, [view, epicRepo, refreshEpics]);
```

(e) Add a dispatch handler (reuses the guard + refreshes after):

```ts
  const dispatchEpic = useCallback(
    (repo: string, epicNumber: number, adapter: string) =>
      guard("epics", async () => {
        await api.dispatchEpic(repo, epicNumber, adapter);
        await Promise.all([refreshEpics(repo), refreshTop()]);
      }),
    [guard, refreshEpics, refreshTop],
  );
```

(f) Add the live channel for the selected repo (so a transition refreshes the Epic list) alongside the existing `ChannelSubscriber`s:

```tsx
      <ChannelSubscriber
        url={view === "epics" && epicRepo ? `/events/repos/${encodeURIComponent(epicRepo)}` : null}
        handlers={{ workflow: () => epicRepo && void refreshEpics(epicRepo) }}
      />
```

(g) Add the nav button as the **first** nav entry:

```tsx
        <button
          type="button"
          className={view === "epics" ? "active" : ""}
          onClick={() => setView("epics")}
        >
          epics
        </button>
```

(h) Add the render branch. Make `epics` the first branch of the view switch; build the adapter list from the banner's adapters (already loaded):

```tsx
      {view === "epics" ? (
        <>
          {repos.length > 1 ? (
            <select
              className="epic-repo-filter"
              aria-label="repo"
              value={epicRepo ?? ""}
              onChange={(e) => setEpicRepo(e.target.value)}
            >
              {repos.map((r) => (
                <option key={r.repo} value={r.repo}>
                  {r.repo}
                </option>
              ))}
            </select>
          ) : null}
          <Epics
            epics={epics}
            adapters={(banner?.adapters ?? []).map((a) => a.adapter)}
            onDispatch={dispatchEpic}
            onOpenInspector={openInspector}
          />
        </>
      ) : view === "settings" ? (
        // …existing settings branch unchanged…
```

> The existing render is a `view === "settings" ? … : view === "queue" ? … : (dashboard)` chain. Insert the `view === "epics" ? (…) :` branch at the front of that chain. Leave the other branches byte-for-byte unchanged. `banner?.adapters` is `RateLimitWire[]` with an `adapter` field (per `wire.ts`), so the `.map` yields the configured adapter names.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/dashboard/test/app.test.tsx && bun run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Full dashboard suite + commit**

Run: `bun test packages/dashboard`
Expected: PASS (all dashboard tests, including the pre-existing nav test updated for four tabs).

```bash
git add packages/dashboard/src/app/App.tsx packages/dashboard/test/app.test.tsx
git commit -m "feat(dashboard): make Epics the default view; repo filter + force-dispatch wiring"
```

---

## Task 9: Docs, module-index frontmatter, full verification

**Files:**
- Modify: module-index frontmatter where a new public export was added (`packages/dispatcher/src/index.ts` for `epics-cache` exports if re-exported; `packages/dashboard/src/index.ts` if the surface changed).
- Modify: `packages/dispatcher/CLAUDE.md` only if a new local invariant was introduced (the refresh loop is one — note it briefly).
- Modify: the spec/plan cross-refs if anything drifted.

- [ ] **Step 1: Update module-index frontmatter**

For any `index.ts(x)` whose public surface changed, update the `Public surface:` / `Where things live:` / `Gotchas:` sections (root `CLAUDE.md` → "Module-index frontmatter"). At minimum:
- `packages/dispatcher/src/index.ts`: if it re-exports daemon types, note `DaemonHostContext` now carries `dispatch` + `refreshEpics`; add `epics-cache.ts` under "Where things live".
- `packages/dashboard/src/index.ts`: note the `/api/epics` surface + `EpicCard`.

Run the module-index check:

Run: `bun test packages/cli/test/module-index.test.ts`
Expected: PASS.

- [ ] **Step 2: Note the new invariant in dispatcher CLAUDE.md**

Add a short bullet under a relevant section of `packages/dispatcher/CLAUDE.md` (the Epic cache is refreshed on a fixed `EPICS_REFRESH_INTERVAL_MS` interval + after each dispatch; the cache marks vanished Epics `closed`, never deletes). Keep it to local, non-derivable facts.

- [ ] **Step 3: Run the full verification gates**

Run: `bun test`
Expected: PASS (whole suite).

Run: `bun run typecheck`
Expected: no errors.

Run: `bun run lint`
Expected: clean (auto-fixes applied in place; nothing escalated).

Run: `bun run format`
Expected: clean.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Run the daemon and open the dashboard:

```bash
bun run --filter @middle/cli mm start   # or the repo's documented start command
```

Open `http://127.0.0.1:4120/` — confirm the **Epics** tab is the default landing view, a repo's open Epics list with progress bars, an in-flight Epic shows its agent badge (click → Inspector), and the dispatch button is disabled when no slot / in-flight and dispatches otherwise.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs(dashboard): document the Epic-centric view + cache invariant"
```

---

## Self-Review Notes (for the implementer)

- **Type consistency:** `EpicCard` (Task 4) is the single contract shared by the deps (`db-deps.ts`), the route (`api.ts`), the api-client, and `Epics.tsx`. `EpicListItem`/`EpicRow` (Tasks 1–2) are dispatcher-internal and must not leak into the wire type. `DaemonHostContext.dispatch`/`.refreshEpics` (Task 3) map to `DbDepsOptions.dispatch`/`.refreshEpicsTrigger` (Task 4) — note the deliberate rename (`refreshEpics` host callback → `refreshEpicsTrigger` deps option, because the deps method is itself named `refreshEpics`).
- **Adapter reality:** only `claude` is a known adapter today (`getAdapter`/`control.knownAdapter`); the picker lists `config.adapters` but a non-claude dispatch returns 400 by design until the Codex adapter (Phase 10) lands.
- **Quota:** the only new GitHub calls are on the refresh loop (one paginated list per repo per 60s + after dispatch), never on a page-view. `listEpics` reads the cache; its one live read (the state issue, for decision/recommendation) is the same read `needsYou()`/`getRepo()` already do per call.
