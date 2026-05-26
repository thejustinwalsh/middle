# Activity View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Activity" dashboard tab that lists recent recommender + documentation workflow runs (the non-implementation kinds every other view filters out), grouped by kind, with drill-in via the existing Inspector.

**Architecture:** A pure additive read over existing `workflows` rows — a new `db-deps.listRuns()` projecting the top 20 rows per non-implementation kind into a `RunSummary` wire type, a `GET /api/runs` route, an `Activity.tsx` view, and a 5th `App.tsx` tab. No new persistence; no GitHub calls (output links are string-built from row data + `repo_config`). Mirrors the `/api/epics` patterns shipped in PR #152.

**Tech Stack:** Bun + TypeScript monorepo, `bun:sqlite`, React 19, `react-dom/server` (`renderToStaticMarkup`) for component tests. `bun test` / `bun run typecheck` / `bun run lint`.

**Reference:** spec `docs/superpowers/specs/2026-05-26-activity-runs-view-design.md`; root `CLAUDE.md` (Conventional Commits — **no AI co-author trailers**; module-index frontmatter). The `/api/epics` code (`db-deps.ts` `listEpics`, `api.ts` `handleEpics`, `Epics.tsx`, the App `epics` wiring) is the sibling template.

---

## File Structure

**Modify:**
- `packages/dashboard/src/wire.ts` — add `RunSummary`.
- `packages/dashboard/src/deps.ts` — add `listRuns()` to `DashboardDeps`.
- `packages/dashboard/src/db-deps.ts` — implement `listRuns`.
- `packages/dashboard/src/api.ts` — add the `runs` route branch.
- `packages/dashboard/src/app/api-client.ts` — add `runs()`.
- `packages/dashboard/src/app/App.tsx` — add the `activity` view/tab/fetch/render.
- `packages/dashboard/src/app/styles.css` — `.activity` scoped styles.
- `packages/dashboard/src/index.ts` — module-index frontmatter (Task 5).

**Create:**
- `packages/dashboard/src/app/components/Activity.tsx`
- `packages/dashboard/test/runs-deps.test.ts`
- `packages/dashboard/test/runs-api.test.ts`
- `packages/dashboard/test/activity.test.tsx`

---

## Task 1: `RunSummary` wire type + `listRuns` dep

**Files:**
- Modify: `packages/dashboard/src/wire.ts`, `packages/dashboard/src/deps.ts`, `packages/dashboard/src/db-deps.ts`
- Test: `packages/dashboard/test/runs-deps.test.ts` (create)

### Step 1: Add the wire type
In `packages/dashboard/src/wire.ts`, append:
```ts
/** One non-implementation run (recommender / documentation) in the Activity view. */
export type RunSummary = {
  workflowId: string;
  kind: "recommender" | "documentation";
  repo: string;
  state: string;
  /** `session_name ?? workflowId` — always set, so the row drills into the Inspector. */
  session: string;
  startedAt: number;
  updatedAt: number;
  /** `updatedAt - startedAt` for terminal runs; `now - startedAt` while active. */
  durationMs: number;
  active: boolean;
  hasTranscript: boolean;
  /** recommender → state-issue URL; documentation → PR URL; else null. */
  outputLink: string | null;
};
```

### Step 2: Add the dep signature
In `packages/dashboard/src/deps.ts`, add `RunSummary` to the `./wire.ts` type import block, and add this method to the `DashboardDeps` type (after `listEpics`):
```ts
  /** Recent non-implementation runs (recommender + documentation) for the Activity view. */
  listRuns(): Promise<RunSummary[]>;
```

### Step 3: Write the failing test
Create `packages/dashboard/test/runs-deps.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createDbDeps } from "../src/db-deps.ts";
import { makeConfig, makeDb } from "./helpers.ts";

let db: Database;
let cleanup: () => void;
beforeEach(() => {
  const made = makeDb();
  db = made.db;
  cleanup = made.cleanup;
});
afterEach(() => cleanup());

/** Insert a workflow row directly (kind-agnostic; the shared seedWorkflow is implementation-only). */
function seedRun(o: {
  id: string;
  kind: "implementation" | "recommender" | "documentation";
  repo: string;
  state?: string;
  createdAt: number;
  updatedAt?: number;
  sessionName?: string | null;
  transcriptPath?: string | null;
  prNumber?: number | null;
}): void {
  db.run(
    `INSERT INTO workflows (id, kind, repo, adapter, state, created_at, updated_at, session_name, transcript_path, pr_number)
     VALUES (?, ?, ?, 'claude', ?, ?, ?, ?, ?, ?)`,
    [
      o.id, o.kind, o.repo, o.state ?? "completed", o.createdAt, o.updatedAt ?? o.createdAt,
      o.sessionName ?? null, o.transcriptPath ?? null, o.prNumber ?? null,
    ],
  );
}

describe("createDbDeps.listRuns", () => {
  test("returns only non-implementation kinds, newest-first within kind", async () => {
    seedRun({ id: "impl1", kind: "implementation", repo: "o/r", createdAt: 100 });
    seedRun({ id: "rec1", kind: "recommender", repo: "o/r", createdAt: 100 });
    seedRun({ id: "rec2", kind: "recommender", repo: "o/r", createdAt: 200 });
    seedRun({ id: "doc1", kind: "documentation", repo: "o/r", createdAt: 150 });
    const runs = await createDbDeps({ db, config: makeConfig() }).listRuns();
    // recommender group first (newest-first), then documentation; the implementation row is excluded.
    expect(runs.map((r) => r.workflowId)).toEqual(["rec2", "rec1", "doc1"]);
    expect(runs.map((r) => r.kind)).toEqual(["recommender", "recommender", "documentation"]);
  });

  test("projects duration, active, transcript, and session fallback", async () => {
    seedRun({ id: "rec-active", kind: "recommender", repo: "o/r", state: "running", createdAt: Date.now() - 5000, sessionName: "s-rec" });
    seedRun({ id: "doc-done", kind: "documentation", repo: "o/r", state: "completed", createdAt: 1000, updatedAt: 4000, transcriptPath: "/t/x.jsonl" });
    const runs = await createDbDeps({ db, config: makeConfig() }).listRuns();
    const rec = runs.find((r) => r.workflowId === "rec-active")!;
    expect(rec).toMatchObject({ active: true, session: "s-rec", hasTranscript: false });
    expect(rec.durationMs).toBeGreaterThanOrEqual(5000);
    const doc = runs.find((r) => r.workflowId === "doc-done")!;
    expect(doc).toMatchObject({ active: false, durationMs: 3000, hasTranscript: true, session: "doc-done" }); // session falls back to id
  });

  test("outputLink: recommender → state issue, documentation → PR, else null", async () => {
    db.run(
      "INSERT INTO repo_config (repo, config_json, state_issue_number, last_synced_at) VALUES (?, ?, ?, ?)",
      ["o/r", "{}", 84, 0],
    );
    seedRun({ id: "rec", kind: "recommender", repo: "o/r", createdAt: 10 });
    seedRun({ id: "doc-pr", kind: "documentation", repo: "o/r", createdAt: 20, prNumber: 251 });
    seedRun({ id: "doc-nopr", kind: "documentation", repo: "o/r", createdAt: 10 });
    const runs = await createDbDeps({ db, config: makeConfig() }).listRuns();
    expect(runs.find((r) => r.workflowId === "rec")!.outputLink).toBe("https://github.com/o/r/issues/84");
    expect(runs.find((r) => r.workflowId === "doc-pr")!.outputLink).toBe("https://github.com/o/r/pull/251");
    expect(runs.find((r) => r.workflowId === "doc-nopr")!.outputLink).toBeNull();
  });

  test("caps at 20 per kind", async () => {
    for (let i = 0; i < 25; i++) seedRun({ id: `rec${i}`, kind: "recommender", repo: "o/r", createdAt: i });
    const runs = await createDbDeps({ db, config: makeConfig() }).listRuns();
    expect(runs.filter((r) => r.kind === "recommender")).toHaveLength(20);
  });
});
```

### Step 4: Run test → `bun test packages/dashboard/test/runs-deps.test.ts` → FAIL (`listRuns` not implemented).

### Step 5: Implement `listRuns` in `db-deps.ts`
Add `RunSummary` to the existing `./wire.ts` import block. Near the other constants (`WORKFLOW_COLUMNS`, `TERMINAL_STATES`), add:
```ts
/** The non-implementation workflow kinds surfaced by the Activity view. */
const NON_IMPL_KINDS = ["recommender", "documentation"] as const;
/** Columns the Activity read projects (a subset distinct from WORKFLOW_COLUMNS). */
const RUN_COLUMNS = "id, repo, state, session_name, created_at, updated_at, transcript_path, pr_number";
```
Add the method to the returned deps object (after `listEpics` is fine):
```ts
    async listRuns(): Promise<RunSummary[]> {
      const now = Date.now();
      const out: RunSummary[] = [];
      for (const kind of NON_IMPL_KINDS) {
        const rows = db
          .query(`SELECT ${RUN_COLUMNS} FROM workflows WHERE kind = ? ORDER BY created_at DESC LIMIT 20`)
          .all(kind) as {
          id: string;
          repo: string;
          state: string;
          session_name: string | null;
          created_at: number;
          updated_at: number;
          transcript_path: string | null;
          pr_number: number | null;
        }[];
        for (const r of rows) {
          const active = !(TERMINAL_STATES as readonly string[]).includes(r.state);
          out.push({
            workflowId: r.id,
            kind,
            repo: r.repo,
            state: r.state,
            session: r.session_name ?? r.id,
            startedAt: r.created_at,
            updatedAt: r.updated_at,
            durationMs: active ? now - r.created_at : r.updated_at - r.created_at,
            active,
            hasTranscript: r.transcript_path !== null,
            outputLink: runOutputLink(kind, r.repo, r.pr_number),
          });
        }
      }
      return out;
    },
```
And a small helper inside `createDbDeps` (it needs `stateIssueNumber`, already defined there):
```ts
  /** "See the result" link: recommender → its state issue, documentation → its PR. */
  function runOutputLink(
    kind: (typeof NON_IMPL_KINDS)[number],
    repo: string,
    prNumber: number | null,
  ): string | null {
    if (kind === "recommender") {
      const n = stateIssueNumber(repo);
      return n === null ? null : `https://github.com/${repo}/issues/${n}`;
    }
    return prNumber === null ? null : `https://github.com/${repo}/pull/${prNumber}`;
  }
```
> Confirm `TERMINAL_STATES`, `stateIssueNumber`, and the deps-object return style by reading `db-deps.ts` first; match them exactly.

### Step 6: Run tests → `bun test packages/dashboard/test/runs-deps.test.ts && bun run typecheck` → PASS (4 tests), clean. Also `bun test packages/dashboard` stays green.

### Step 7: Commit
```bash
git add packages/dashboard/src/wire.ts packages/dashboard/src/deps.ts packages/dashboard/src/db-deps.ts packages/dashboard/test/runs-deps.test.ts
git commit -m "feat(dashboard): RunSummary wire type + listRuns deps read"
```

---

## Task 2: `GET /api/runs` route

**Files:**
- Modify: `packages/dashboard/src/api.ts`
- Test: `packages/dashboard/test/runs-api.test.ts` (create)

### Step 1: Write the failing test
Create `packages/dashboard/test/runs-api.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { handleApi } from "../src/api.ts";
import type { DashboardDeps } from "../src/deps.ts";

function deps(over: Partial<DashboardDeps>): DashboardDeps {
  return { listRuns: async () => [] as never, ...over } as unknown as DashboardDeps;
}
const req = (path: string, method = "GET") => new Request(`http://x${path}`, { method });

describe("/api/runs", () => {
  test("GET /api/runs returns the run list", async () => {
    const runs = [{ workflowId: "rec1", kind: "recommender" }];
    const res = await handleApi(req("/api/runs"), deps({ listRuns: async () => runs as never }));
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual(runs);
  });

  test("a non-GET method on /api/runs is a 404 miss", async () => {
    const res = await handleApi(req("/api/runs", "POST"), deps({}));
    expect(res!.status).toBe(404);
  });
});
```

### Step 2: Run test → `bun test packages/dashboard/test/runs-api.test.ts` → FAIL (no `runs` route).

### Step 3: Implement the route
In `packages/dashboard/src/api.ts` `handleApi`, add a branch beside the others (e.g. after the `epics` branch). It takes no path params:
```ts
  if (resource === "runs" && tail.length === 0 && method === "GET") {
    return Response.json(await deps.listRuns());
  }
```
> Match the existing `resource === "banner" … && method === "GET"` single-line style. Place it among the other `resource ===` checks.

### Step 4: Run tests → `bun test packages/dashboard/test/runs-api.test.ts && bun run typecheck` → PASS (2 tests). `bun test packages/dashboard` green.

### Step 5: Commit
```bash
git add packages/dashboard/src/api.ts packages/dashboard/test/runs-api.test.ts
git commit -m "feat(dashboard): GET /api/runs route"
```

---

## Task 3: `api-client.runs()` + `Activity.tsx`

**Files:**
- Modify: `packages/dashboard/src/app/api-client.ts`, `packages/dashboard/src/app/styles.css`
- Create: `packages/dashboard/src/app/components/Activity.tsx`
- Test: `packages/dashboard/test/activity.test.tsx` (create)

### Step 1: Add the api-client method
In `packages/dashboard/src/app/api-client.ts`, add `RunSummary` to the `../wire.ts` import block, then add to the `api` object (after `dispatchEpic`):
```ts
  runs: () => getJson<RunSummary[]>("/api/runs"),
```

### Step 2: Write the failing component test
Create `packages/dashboard/test/activity.test.tsx`:
```tsx
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Activity } from "../src/app/components/Activity.tsx";
import type { RunSummary } from "../src/wire.ts";

const run = (over: Partial<RunSummary> = {}): RunSummary => ({
  workflowId: "rec1", kind: "recommender", repo: "o/r", state: "completed",
  session: "s-rec", startedAt: 1000, updatedAt: 4000, durationMs: 3000,
  active: false, hasTranscript: true, outputLink: "https://github.com/o/r/issues/84",
  ...over,
});
const html = (runs: RunSummary[]) =>
  renderToStaticMarkup(<Activity runs={runs} now={5000} onOpenInspector={() => {}} />);

describe("Activity", () => {
  test("renders Recommender and Documentation sections", () => {
    const out = html([run(), run({ workflowId: "doc1", kind: "documentation", outputLink: null })]);
    expect(out).toContain("Recommender");
    expect(out).toContain("Documentation");
    expect(out).toContain("o/r");
  });

  test("shows an output link when present and omits it otherwise", () => {
    const out = html([run()]);
    expect(out).toContain('href="https://github.com/o/r/issues/84"');
    const noLink = html([run({ outputLink: null })]);
    expect(noLink).not.toContain("<a ");
  });

  test("empty state per section when no runs of that kind", () => {
    const out = html([run({ kind: "recommender" })]); // no documentation runs
    expect(out).toContain("No documentation runs yet.");
  });

  test("renders a state label for each run", () => {
    const out = html([run({ state: "failed", active: false })]);
    expect(out).toContain("failed");
  });
});
```

### Step 3: Run test → `bun test packages/dashboard/test/activity.test.tsx` → FAIL (`Activity.tsx` missing).

### Step 4: Implement `Activity.tsx`
```tsx
// packages/dashboard/src/app/components/Activity.tsx
/**
 * The Activity view — recent recommender + documentation runs (the workflow kinds
 * the Epic/Queue views filter out), grouped by kind, newest-first. Each row drills
 * into the existing Inspector via its session. Read-only; the data is a snapshot
 * of `workflows` rows projected by {@link RunSummary}.
 */
import type { RunSummary } from "../../wire.ts";
import { ago } from "../format.ts";

/** A coarse health class for the state pill. */
function tone(run: RunSummary): "active" | "ok" | "bad" {
  if (run.active) return "active";
  return run.state === "completed" || run.state === "compensated" ? "ok" : "bad";
}

function RunRow({
  run,
  now,
  onOpenInspector,
}: {
  run: RunSummary;
  now?: number;
  onOpenInspector?: (session: string) => void;
}) {
  return (
    <li className="run-row" data-run={run.workflowId}>
      <button type="button" className="run-open" onClick={() => onOpenInspector?.(run.session)}>
        <span className={`run-state ${tone(run)}`}>{run.state}</span>
        <span className="run-repo">{run.repo}</span>
        <span className="run-when">
          {ago(run.startedAt, now)} ago · {Math.round(run.durationMs / 1000)}s
        </span>
      </button>
      {run.outputLink ? (
        <a className="run-output" href={run.outputLink}>
          ↗ output
        </a>
      ) : null}
    </li>
  );
}

function Section({
  title,
  runs,
  emptyLabel,
  now,
  onOpenInspector,
}: {
  title: string;
  runs: RunSummary[];
  emptyLabel: string;
  now?: number;
  onOpenInspector?: (session: string) => void;
}) {
  return (
    <section className="run-section">
      <h3>{title}</h3>
      {runs.length === 0 ? (
        <p className="empty">{emptyLabel}</p>
      ) : (
        <ul>
          {runs.map((run) => (
            <RunRow key={run.workflowId} run={run} now={now} onOpenInspector={onOpenInspector} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function Activity({
  runs,
  now,
  onOpenInspector,
}: {
  runs: RunSummary[];
  now?: number;
  onOpenInspector?: (session: string) => void;
}) {
  const recommender = runs.filter((r) => r.kind === "recommender");
  const documentation = runs.filter((r) => r.kind === "documentation");
  return (
    <section className="activity" aria-labelledby="activity-h">
      <h2 id="activity-h">ACTIVITY</h2>
      <Section title="Recommender" runs={recommender} emptyLabel="No recommender runs yet." now={now} onOpenInspector={onOpenInspector} />
      <Section title="Documentation" runs={documentation} emptyLabel="No documentation runs yet." now={now} onOpenInspector={onOpenInspector} />
    </section>
  );
}
```
> Confirm `ago` is exported from `packages/dashboard/src/app/format.ts` with signature `ago(ts: number, now?: number): string` (the Inspector/Repos use it). If its name/signature differs, match the real one.

### Step 5: Run tests → `bun test packages/dashboard/test/activity.test.tsx && bun run typecheck` → PASS (4 tests). `bun test packages/dashboard` green.

### Step 6: Add styles + commit
Append to `packages/dashboard/src/app/styles.css` (follow the existing `.epics`/`.queue` scoping):
```css
.activity .run-section { margin-bottom: 1rem; }
.activity .run-row { display: flex; align-items: baseline; gap: 0.5rem; padding: 0.15rem 0; }
.activity .run-open { display: flex; gap: 0.6rem; align-items: baseline; background: none; border: none; color: inherit; cursor: pointer; text-align: left; }
.activity .run-state { font-size: 0.7rem; text-transform: uppercase; padding: 0 0.3rem; border-radius: 3px; }
.activity .run-state.active { background: #234; }
.activity .run-state.ok { background: #143; }
.activity .run-state.bad { background: #511; }
.activity .run-when { opacity: 0.7; font-size: 0.8rem; }
.activity .run-output { font-size: 0.8rem; }
```
```bash
git add packages/dashboard/src/app/api-client.ts packages/dashboard/src/app/components/Activity.tsx packages/dashboard/src/app/styles.css packages/dashboard/test/activity.test.tsx
git commit -m "feat(dashboard): Activity view component + api-client runs()"
```

---

## Task 4: Wire `Activity` into `App.tsx` (5th tab)

**Files:**
- Modify: `packages/dashboard/src/app/App.tsx`
- Test: `packages/dashboard/test/app.test.tsx` (extend)

READ `App.tsx` first. Current state (on `main`): `view` is `"epics" | "dashboard" | "queue" | "settings"` (default `"epics"`, ~line 65); `<nav className="view-nav">` has epics/dashboard/queue/settings buttons (~line 317+); a `/control/events` ChannelSubscriber gated on `view === "queue"` (~line 305); render chain `view === "epics" ? … : view === "settings" ? … : view === "queue" ? … : (dashboard)` (~line 347+); `openInspector(session)` + `<Inspector>` drawer already exist; `POLL_MS`, `guard`, `api` imported.

### Step 1: Write the failing test
Add to `packages/dashboard/test/app.test.tsx`:
```tsx
test("App nav includes an activity tab", () => {
  const html = renderToStaticMarkup(<App />);
  expect(html).toContain(">activity<");
});

test("api.runs reads runs from a live server", async () => {
  const { db, cleanup } = makeDb();
  try {
    db.run(
      `INSERT INTO workflows (id, kind, repo, adapter, state, created_at, updated_at)
       VALUES ('rec1', 'recommender', 'o/r', 'claude', 'completed', 1000, 4000)`,
    );
    const deps = createDbDeps({ db, config: makeConfig() });
    const server = await createDashboardServer({ deps, port: 0, serveSpa: false });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/runs`);
      expect(res.status).toBe(200);
      const runs = (await res.json()) as { workflowId: string; kind: string }[];
      expect(runs[0]).toMatchObject({ workflowId: "rec1", kind: "recommender" });
    } finally {
      server.stop(true);
    }
  } finally {
    cleanup();
  }
});
```
> The file already imports `renderToStaticMarkup`, `App`, `createDbDeps`, `createDashboardServer`, `makeConfig`, `makeDb` (used by the epics tests). Reuse them; match the existing live-server describe block's `createDashboardServer({ deps, port: 0, serveSpa: false })` + `server.port` + `server.stop(true)` idiom.

Run `bun test packages/dashboard/test/app.test.tsx` → the nav test FAILS (no `>activity<`); the live-server test PASSES (Task 1/2 wired `/api/runs`).

### Step 2: Edit `App.tsx`
(a) Imports — add `import { Activity } from "./components/Activity.tsx";` and add `RunSummary` to the `../wire.ts` type import.

(b) View-state type — add `"activity"`:
```ts
  const [view, setView] = useState<"epics" | "dashboard" | "queue" | "activity" | "settings">("epics");
```

(c) State + fetch near the epics state/effects:
```ts
  const [runs, setRuns] = useState<RunSummary[]>([]);

  const refreshRuns = useCallback(
    () => guard("activity", async () => setRuns(await api.runs())),
    [guard],
  );

  useEffect(() => {
    if (view !== "activity") return;
    void refreshRuns();
    const id = setInterval(() => void refreshRuns(), POLL_MS);
    return () => clearInterval(id);
  }, [view, refreshRuns]);
```

(d) Live refetch — extend the existing `/control/events` ChannelSubscriber so it also feeds Activity. Change its `url` gate and add a `workflow` handler that refreshes runs when on the Activity tab. The existing subscriber (gated on `view === "queue"`) updates `queueLive`; add a second `ChannelSubscriber` (simplest, avoids disturbing the queue one) alongside it:
```tsx
      <ChannelSubscriber
        url={view === "activity" ? "/control/events" : null}
        handlers={{ workflow: () => void refreshRuns() }}
      />
```

(e) Nav button — add as the 4th entry, **after** `queue` and **before** `settings`:
```tsx
        <button
          type="button"
          className={view === "activity" ? "active" : ""}
          onClick={() => setView("activity")}
        >
          activity
        </button>
```

(f) Render branch — add to the view-switch chain (before the `settings`/`queue`/dashboard branches; placement among the `? :` chain just needs to be a distinct arm). Insert an `activity` arm:
```tsx
      ) : view === "activity" ? (
        <Activity runs={runs} onOpenInspector={openInspector} />
```
Wire it into the existing chain so the JSX stays balanced — e.g. the chain becomes `view === "epics" ? (…) : view === "activity" ? (<Activity … />) : view === "settings" ? (…) : view === "queue" ? (…) : (dashboard)`. Confirm the exact existing chain by reading the render return and insert the arm without altering the other arms.

> `openInspector` already exists and takes a session string; `Activity` passes `run.session` to it. No new Inspector code.

### Step 3: Run tests → `bun test packages/dashboard/test/app.test.tsx && bun run typecheck` → PASS. `bun test packages/dashboard` green. `bun run lint` clean.

### Step 4: Commit
```bash
git add packages/dashboard/src/app/App.tsx packages/dashboard/test/app.test.tsx
git commit -m "feat(dashboard): wire the Activity tab into the SPA"
```

---

## Task 5: Module-index frontmatter + full verification

**Files:**
- Modify: `packages/dashboard/src/index.ts` (frontmatter)

### Step 1: Update the dashboard module-index frontmatter
In `packages/dashboard/src/index.ts`'s leading TSDoc block, extend the relevant sections (root `CLAUDE.md` → "Module-index frontmatter"): note the `/api/runs` surface + the `RunSummary` wire type + the `Activity` view (mirror how `/api/epics` / `EpicCard` / `Epics` are described). Keep edits accurate; change no `claude-md:` flag.

Run the gating check: `bun test packages/cli/test/module-index.test.ts` → PASS.

### Step 2: Full verification (report actual output)
```bash
bun test            # whole monorepo — all green
bun run typecheck   # clean
bun run lint        # clean (oxlint auto-fixes in place)
bun run format      # stage anything it reformats
```
If any gate fails for a real reason, STOP and report rather than papering over it.

### Step 3: Commit
```bash
git add -A
git commit -m "docs(dashboard): document the Activity view in the module index"
```

---

## Self-Review Notes (for the implementer)

- **Type consistency:** `RunSummary` (Task 1) is the single contract shared by `listRuns` (deps), `/api/runs` (route), `api.runs()` (client), and `Activity.tsx`. `session` is always set (`session_name ?? id`) so every row drills into the Inspector via the existing `openInspector`.
- **No new GitHub calls:** `outputLink` is string-built from `repo_config.state_issue_number` (recommender) and the row's `pr_number` (documentation) — both already in the db.
- **`TERMINAL_STATES`** is the existing `db-deps` constant; `active = !TERMINAL_STATES.includes(state)`. The `as readonly string[]` cast is only to satisfy `.includes` on the `as const` tuple.
- **Reuse, don't rebuild:** drill-in is the existing `Inspector` (epic shows "—" for these runs); no Inspector changes in this plan.
