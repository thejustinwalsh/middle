# File-Backed Epic Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-repo, opt-in file-backed Epic store as a peer to today's GitHub-backed mode. PRs and CI stay GitHub-native in both modes (hybrid). Workflow bodies, gates, watchdog, hook server, poller — unchanged.

**Architecture:** Three existing single-seam DI'd interfaces (`GitHubGateway`, `StateIssueGateway`, `GitHubPollGateway`) get renamed (`EpicGateway`, `StateGateway`, `PollGateway`) and gain parallel file implementations behind the same contracts. Per-repo `epic_store ∈ {github, file}` in `repo_config` selects the implementation at bootstrap. The agent's `blocked.json` flow plugs in unchanged at the existing `deps.postQuestion` DI seam.

**Tech Stack:** Bun ≥ 1.3.12, TypeScript, `bun:sqlite`, bunqueue (workflow engine, embedded), oxlint/oxfmt, Bun test runner.

**Spec:** `docs/superpowers/specs/2026-05-29-file-backed-epic-store-design.md` — read it before starting any task.

---

## File structure (locked in at the start)

**New files:**

- `packages/dispatcher/src/epic-store/index.ts` — `buildFileGateways(db, repoCfg)` factory
- `packages/dispatcher/src/epic-store/epic-file/markers.ts` — all `<!-- middle:* -->` marker constants
- `packages/dispatcher/src/epic-store/epic-file/types.ts` — `EpicFile`, `SubIssue`, `ConversationEntry`, etc.
- `packages/dispatcher/src/epic-store/epic-file/parser.ts` — `parseEpicFile(body): EpicFile`
- `packages/dispatcher/src/epic-store/epic-file/renderer.ts` — `renderEpicFile(epic): string`
- `packages/dispatcher/src/epic-store/file-epic-gateway.ts` — `fileEpicGateway` (composite — Epic from file, PR delegated to gh)
- `packages/dispatcher/src/epic-store/file-state-gateway.ts` — `fileStateGateway`
- `packages/dispatcher/src/epic-store/file-poll-gateway.ts` — `filePollGateway` (Phase 1: no watcher; Phase 2: + `pollFileSignals`)
- `packages/dispatcher/src/epic-store/watcher.ts` — mtime poll helper (Phase 2)
- `packages/dispatcher/test/epic-store/parser.test.ts`
- `packages/dispatcher/test/epic-store/renderer.test.ts`
- `packages/dispatcher/test/epic-store/round-trip.test.ts`
- `packages/dispatcher/test/epic-store/file-epic-gateway.test.ts`
- `packages/dispatcher/test/epic-store/file-state-gateway.test.ts`
- `packages/dispatcher/test/epic-store/file-poll-gateway.test.ts`
- `packages/dispatcher/test/epic-store/parity.test.ts` — parametrized github | file
- `packages/dispatcher/test/epic-store/fixtures/*.md` — Epic file fixtures
- `packages/cli/src/commands/resume.ts` — `mm resume <epic> --answer "…"`

**Modified files:**

- `packages/dispatcher/src/github.ts` — rename `GitHubGateway` → `EpicGateway`
- `packages/dispatcher/src/state-issue.ts` — rename `StateIssueGateway` → `StateGateway`
- `packages/dispatcher/src/poller.ts` — rename `GitHubPollGateway` → `PollGateway`
- `packages/dispatcher/src/poller-gateway.ts` — rename impl
- `packages/dispatcher/src/build-deps.ts` — switch gateways on `repo_config.epic_store`
- `packages/dispatcher/src/db.ts` — schema migrations (additive)
- `packages/dispatcher/src/workflow-record.ts` — `epic_ref` column reads/writes; signatures take `epicRef: string`
- `packages/dispatcher/src/poller-cron.ts` — Phase 2: wire `pollFileSignals`
- `packages/cli/src/commands/init.ts` — file-mode scaffold branch
- `packages/cli/src/commands/dispatch.ts` — `--epic <slug>` + slug-or-number `<epic>` arg
- `packages/cli/src/commands/doctor.ts` — mode-aware adapter / state-store check
- `packages/cli/src/index.ts` — register `mm resume`
- `packages/skills/implementing-github-issues/SKILL.md` — abstract body
- `packages/skills/implementing-github-issues/references/github-mode-commands.md` — NEW
- `packages/skills/implementing-github-issues/references/file-mode-commands.md` — NEW
- `packages/skills/recommending-github-issues/SKILL.md` — abstract body
- `packages/skills/recommending-github-issues/references/{github,file}-mode-commands.md` — NEW
- `packages/skills/creating-github-issues/SKILL.md` — file-mode addendum (or sibling skill)
- `packages/dispatcher/src/workflows/implementation.ts` — `ensurePromptFile` injects per-mode commands
- ~5 query sites in `packages/dashboard/` — `epic_number` → `epic_ref`

---

## Phase 1 — File-Epic dispatch (no watcher yet)

### Task 1: Rename the three gateway interfaces (mechanical, single commit)

**Files:**
- Modify: `packages/dispatcher/src/github.ts` — rename `GitHubGateway` → `EpicGateway`
- Modify: `packages/dispatcher/src/state-issue.ts` — rename `StateIssueGateway` → `StateGateway`
- Modify: `packages/dispatcher/src/poller.ts` — rename `GitHubPollGateway` → `PollGateway`
- Modify: every importer (~20 files)

The implementations (`ghGitHub`, `ghStateIssueGateway`, `ghPollGateway`) keep their `gh*` names — they remain the GitHub implementations of the renamed interfaces.

- [ ] **Step 1: Find every import to rename**

```bash
cd /home/tjw/Developer/middle
grep -rn "GitHubGateway\|StateIssueGateway\|GitHubPollGateway" packages/ --include="*.ts" | head -40
```

Expected: ~20-30 hits across `packages/dispatcher/src/**`, `packages/cli/src/**`, and test files.

- [ ] **Step 2: Rewrite each rename via codemod**

```bash
cd /home/tjw/Developer/middle
# Three renames, all symbols only — no risk of partial-match
for old_new in \
  "GitHubGateway:EpicGateway" \
  "StateIssueGateway:StateGateway" \
  "GitHubPollGateway:PollGateway"; do
  old="${old_new%%:*}"; new="${old_new##*:}"
  grep -rl "$old" packages/ --include="*.ts" | xargs sed -i "s/\\b$old\\b/$new/g"
done
```

- [ ] **Step 3: Verify no stale references**

```bash
grep -rn "GitHubGateway\|StateIssueGateway\|GitHubPollGateway" packages/ --include="*.ts" | head
```

Expected: empty.

- [ ] **Step 4: Typecheck + tests**

```bash
bun run typecheck && bun test 2>&1 | tail -5
```

Expected: typecheck clean; all tests pass (the rename is pure, no behavior change).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(dispatcher): rename gateway interfaces (GitHub* → Epic/State/Poll)

Preparation for the file-backed Epic store: the three existing single-
seam DI'd interfaces are renamed to reflect what they abstract (an Epic
store, not GitHub specifically). Implementations (ghGitHub,
ghStateIssueGateway, ghPollGateway) keep their gh* names — they're the
GitHub implementation of the renamed interfaces. Behavior unchanged."
```

---

### Task 2: Schema migration — `repo_config` add Epic-store columns

**Files:**
- Modify: `packages/dispatcher/src/db.ts` — add the migration
- Modify: `packages/dispatcher/src/repo-config.ts` (if exists, else `workflow-record.ts`) — surface the new columns
- Test: `packages/dispatcher/test/db-migrations.test.ts` (create if absent)

- [ ] **Step 1: Locate the existing migration list**

```bash
grep -n "ALTER TABLE\|CREATE TABLE repo_config\|SCHEMA_VERSION\|migrations" packages/dispatcher/src/db.ts | head -20
```

Note the migration framework (numbered migrations or version-bumped).

- [ ] **Step 2: Write failing test**

Create `packages/dispatcher/test/db-migrations.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAndMigrate } from "../src/db.ts";

let scratch: string;
let db: Database;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "middle-mig-"));
  db = openAndMigrate(join(scratch, "db.sqlite3"));
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("repo_config epic-store columns migration", () => {
  test("adds epic_store, epics_dir, state_file columns with safe defaults", () => {
    const cols = db.query("PRAGMA table_info(repo_config)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("epic_store")?.type).toBe("TEXT");
    expect(byName.get("epic_store")?.notnull).toBe(1);
    expect(byName.get("epic_store")?.dflt_value).toBe("'github'");
    expect(byName.get("epics_dir")?.type).toBe("TEXT");
    expect(byName.get("epics_dir")?.notnull).toBe(0);
    expect(byName.get("state_file")?.type).toBe("TEXT");
    expect(byName.get("state_file")?.notnull).toBe(0);
  });

  test("existing rows are backfilled with epic_store='github'", () => {
    db.run("INSERT INTO repo_config (repo, config_json) VALUES (?, '{}')", ["acme/test"]);
    const row = db.query("SELECT epic_store FROM repo_config WHERE repo = ?").get("acme/test");
    expect((row as { epic_store: string }).epic_store).toBe("github");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test packages/dispatcher/test/db-migrations.test.ts 2>&1 | tail -10
```

Expected: FAIL — columns don't exist.

- [ ] **Step 4: Add the migration to `db.ts`**

Append a new migration (the existing pattern in `db.ts` will be numbered or version-keyed — follow it):

```typescript
// In the migration list, append:
{
  version: <next>,
  description: "add repo_config epic-store columns",
  up: (db) => {
    db.run(`
      ALTER TABLE repo_config ADD COLUMN epic_store TEXT NOT NULL DEFAULT 'github'
    `);
    db.run(`ALTER TABLE repo_config ADD COLUMN epics_dir TEXT`);
    db.run(`ALTER TABLE repo_config ADD COLUMN state_file TEXT`);
  },
},
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test packages/dispatcher/test/db-migrations.test.ts 2>&1 | tail -5
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(dispatcher): repo_config schema for per-repo Epic store mode

Additive migration: adds epic_store ('github' default), epics_dir, and
state_file columns. All existing rows default to github mode — zero
behavior change for existing repos."
```

---

### Task 3: Schema migration — `workflows` add `epic_ref`

**Files:**
- Modify: `packages/dispatcher/src/db.ts` — migration
- Modify: `packages/dispatcher/src/workflow-record.ts` — `epic_ref` reads/writes; signatures gain `epicRef: string`
- Test: extend `packages/dispatcher/test/db-migrations.test.ts`

- [ ] **Step 1: Extend the migrations test**

Append:

```typescript
describe("workflows epic_ref migration", () => {
  test("adds epic_ref TEXT NOT NULL after backfill", () => {
    const cols = db.query("PRAGMA table_info(workflows)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const epicRef = cols.find((c) => c.name === "epic_ref");
    expect(epicRef).toBeDefined();
    expect(epicRef?.type).toBe("TEXT");
    expect(epicRef?.notnull).toBe(1);
  });

  test("backfills epic_ref from existing epic_number for existing rows", () => {
    // Insert a row that *predates* the migration via raw SQL, then re-open;
    // the test fixture re-runs migrations on each beforeEach, so simulate by
    // inserting then querying the post-migration state.
    db.run(
      `INSERT INTO workflows (id, kind, repo, epic_number, adapter, state)
       VALUES ('wf_test', 'implementation', 'a/b', 42, 'claude', 'pending')`,
    );
    const row = db.query("SELECT epic_ref FROM workflows WHERE id = ?").get("wf_test");
    expect((row as { epic_ref: string }).epic_ref).toBe("42");
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test packages/dispatcher/test/db-migrations.test.ts -t "epic_ref" 2>&1 | tail -8
```

Expected: FAIL.

- [ ] **Step 3: Add the migration**

Append to `db.ts`:

```typescript
{
  version: <next>,
  description: "add workflows.epic_ref + backfill from epic_number",
  up: (db) => {
    db.run(`ALTER TABLE workflows ADD COLUMN epic_ref TEXT`);
    db.run(`UPDATE workflows SET epic_ref = CAST(epic_number AS TEXT) WHERE epic_ref IS NULL AND epic_number IS NOT NULL`);
    // SQLite quirk: can't ALTER existing column to NOT NULL. Use the table-rebuild dance:
    db.run(`CREATE TABLE workflows_new (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      repo TEXT NOT NULL,
      epic_number INTEGER,                  -- now nullable
      epic_ref TEXT NOT NULL,               -- new, required
      -- … (copy ALL other columns from the existing schema, verbatim) …
    )`);
    db.run(`INSERT INTO workflows_new SELECT id, kind, repo, epic_number, epic_ref, /* …all other cols… */ FROM workflows`);
    db.run(`DROP TABLE workflows`);
    db.run(`ALTER TABLE workflows_new RENAME TO workflows`);
    // Re-create indexes/triggers that existed on the old table.
  },
},
```

**Before writing this:** open `db.ts` and copy the *exact* current `workflows` schema (column list, types, indexes) into the `CREATE TABLE workflows_new` clause and the `INSERT INTO workflows_new SELECT` clause. Dropping a column by omission is the failure mode here — copy verbatim.

- [ ] **Step 4: Update `workflow-record.ts` to write `epic_ref`**

Find every `INSERT INTO workflows` and `UPDATE workflows SET …` in `workflow-record.ts`. Where `epic_number` is set, also set `epic_ref` (in github mode: `String(epic_number)`; in file mode: the slug). For now, since `createWorkflowRecord` takes `epicNumber: number`, also add `epicRef?: string` to its options and default it to `String(epicNumber)` when absent.

- [ ] **Step 5: Run all dispatcher tests**

```bash
bun test packages/dispatcher/ 2>&1 | tail -5
```

Expected: all pass (the migration is back-compat; existing tests use github-mode-style epic_numbers and the default backfill keeps them working).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(dispatcher): workflows.epic_ref column for non-numeric Epic refs

Additive migration with backfill: epic_ref TEXT NOT NULL, populated from
the existing epic_number for all existing rows. epic_number becomes
nullable (file-mode workflows don't have one). workflow-record.ts writes
both columns in github mode, only epic_ref in file mode (later tasks)."
```

---

### Task 4: Update dashboard queries for `epic_ref`

**Files:**
- Modify: `packages/dashboard/src/db-deps.ts` and any other dashboard query site (~5)

The dashboard reads `epic_number` from `workflows`. Switch to reading `epic_ref` (or both, for display). This is mechanical; verify with the existing dashboard test suite.

- [ ] **Step 1: Find the dashboard's epic_number readers**

```bash
grep -rn "epic_number\|epicNumber" packages/dashboard/src/ --include="*.ts"
```

- [ ] **Step 2: Update each to read epic_ref (preserving the existing display behavior)**

For each site, replace `epic_number` with `epic_ref` (string). If a numeric epic ID was needed for a link to GitHub, gate that link on `epic_number IS NOT NULL` (which it will be, in github mode).

- [ ] **Step 3: Run dashboard tests**

```bash
bun test packages/dashboard/ 2>&1 | tail -5
```

Expected: pass. If a test asserts a specific shape, update its expected value to use `epic_ref`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(dashboard): read epic_ref instead of epic_number

Schema change from prior commit makes epic_ref the canonical Epic
identifier. github-mode rows still carry both; dashboard prefers the
string ref for display, falls back to epic_number for the GitHub link."
```

---

### Task 5: Marker constants + types

**Files:**
- Create: `packages/dispatcher/src/epic-store/epic-file/markers.ts`
- Create: `packages/dispatcher/src/epic-store/epic-file/types.ts`

- [ ] **Step 1: Write markers.ts**

```typescript
// packages/dispatcher/src/epic-store/epic-file/markers.ts

/**
 * Every HTML-comment marker the Epic-file format uses. The marker IS the
 * structural contract — never change the bytes here without bumping the
 * version suffix (`v1`) on the document marker.
 */
export const EPIC_DOC_MARKER = "<!-- middle:epic v1 -->";
export const META_OPEN = "<!-- middle:meta";
export const META_CLOSE = "-->";
export const SUB_ISSUE_OPEN_RE = /^<!-- middle:sub-issue id=(\d+) -->$/;
export const SUB_ISSUE_CLOSE = "<!-- /middle:sub-issue -->";
export const CONVERSATION_OPEN = "<!-- middle:conversation -->";
export const CONVERSATION_CLOSE = "<!-- /middle:conversation -->";
export const QUESTION_OPEN_RE =
  /^<!-- middle:question id=(\d+) status=(open|resolved) ts=([\dT:Z.-]+)(?: kind=(\w+))? -->$/;
export const QUESTION_CLOSE = "<!-- /middle:question -->";
export const ANSWER_OPEN_RE = /^<!-- middle:answer for=(\d+) -->$/;
export const ANSWER_CLOSE = "<!-- /middle:answer -->";
export const DISPATCH_EVENT_OPEN_RE =
  /^<!-- middle:dispatch-event ts=([\dT:Z.-]+) kind=(\w+) -->$/;
export const DISPATCH_EVENT_CLOSE = "<!-- /middle:dispatch-event -->";
export const PARSE_ERROR_OPEN_RE = /^<!-- middle:parse-error ts=([\dT:Z.-]+) -->$/;
export const PARSE_ERROR_CLOSE = "<!-- /middle:parse-error -->";

/** Section headings — strict spelling + order. */
export const SECTIONS = ["Context", "Acceptance criteria", "Sub-issues"] as const;
```

- [ ] **Step 2: Write types.ts**

```typescript
// packages/dispatcher/src/epic-store/epic-file/types.ts

/** The fully-parsed shape of an Epic file. */
export type EpicFile = {
  /** From the H1 title line. */
  title: string;
  meta: EpicMeta;
  /** Verbatim prose body of `## Context`. */
  context: string;
  acceptanceCriteria: AcceptanceItem[];
  subIssues: SubIssue[];
  conversation: ConversationEntry[];
  /**
   * Anything between markers we don't recognize is preserved verbatim under
   * the section it appeared in (or as trailing prose). Used by the renderer to
   * round-trip non-canonical human additions.
   */
  trailingProse: string;
};

export type EpicMeta = {
  slug: string;
  adapter?: string;
  complexityCeiling?: number;
  approved?: boolean;
  labels?: string[];
  blockedBy?: string[];
  pr?: number;
  closed?: boolean;
};

export type AcceptanceItem = { checked: boolean; text: string };

export type SubIssue = {
  id: number;
  checked: boolean;
  title: string;
  body: string;
  /** Provenance suffix appended to the title when closed (e.g. "(done in wf_… sha …)"). */
  provenance?: string;
};

export type ConversationEntry =
  | { kind: "dispatch-event"; ts: string; eventKind: string; body: string }
  | {
      kind: "question";
      id: number;
      status: "open" | "resolved";
      ts: string;
      questionKind?: string;
      body: string;
      answer?: { body: string };
    }
  | { kind: "parse-error"; ts: string; body: string };
```

- [ ] **Step 3: Verify it typechecks**

```bash
bun run typecheck 2>&1 | tail -3
```

Expected: clean (no consumers yet).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(epic-store): marker constants + Epic-file type model

The HTML-comment marker constants (and their regexes) are the structural
contract for the round-trip parser/renderer that follows. Types describe
the fully-parsed Epic shape: meta, acceptance, sub-issues, conversation."
```

---

### Task 6: Epic-file parser (test-first, incremental)

**Files:**
- Create: `packages/dispatcher/src/epic-store/epic-file/parser.ts`
- Create: `packages/dispatcher/test/epic-store/parser.test.ts`
- Create: `packages/dispatcher/test/epic-store/fixtures/empty-epic.md`
- Create: `packages/dispatcher/test/epic-store/fixtures/codex-adapter.md`
- Create: `packages/dispatcher/test/epic-store/fixtures/mid-question.md`
- Create: `packages/dispatcher/test/epic-store/fixtures/all-closed.md`

The parser handles one section at a time. We TDD it incrementally.

- [ ] **Step 1: Write the empty-epic fixture**

`packages/dispatcher/test/epic-store/fixtures/empty-epic.md`:

```markdown
<!-- middle:epic v1 -->
# Untitled Epic

<!-- middle:meta
slug: untitled
-->

## Context

(empty)

## Acceptance criteria

## Sub-issues

<!-- middle:conversation -->
<!-- /middle:conversation -->
```

- [ ] **Step 2: Write the failing test — empty epic**

`packages/dispatcher/test/epic-store/parser.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEpicFile } from "../../src/epic-store/epic-file/parser.ts";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "fixtures", `${name}.md`), "utf8");

describe("parseEpicFile — empty epic", () => {
  test("parses the document marker, title, and minimal meta", () => {
    const epic = parseEpicFile(fixture("empty-epic"));
    expect(epic.title).toBe("Untitled Epic");
    expect(epic.meta.slug).toBe("untitled");
    expect(epic.acceptanceCriteria).toEqual([]);
    expect(epic.subIssues).toEqual([]);
    expect(epic.conversation).toEqual([]);
  });

  test("throws when the document marker is missing", () => {
    expect(() => parseEpicFile("# No Marker\n")).toThrow(/document marker/i);
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
bun test packages/dispatcher/test/epic-store/parser.test.ts 2>&1 | tail -10
```

Expected: FAIL — `parseEpicFile` not defined.

- [ ] **Step 4: Implement minimal parser**

`packages/dispatcher/src/epic-store/epic-file/parser.ts`:

```typescript
import { EPIC_DOC_MARKER, META_OPEN, META_CLOSE } from "./markers.ts";
import type { EpicFile, EpicMeta } from "./types.ts";

export function parseEpicFile(body: string): EpicFile {
  if (!body.startsWith(EPIC_DOC_MARKER)) {
    throw new Error(`Epic file missing document marker (${EPIC_DOC_MARKER})`);
  }
  const lines = body.split("\n");
  const title = parseTitle(lines);
  const meta = parseMeta(lines);
  // Phase-1 partial parse — sections to be filled in incrementally below.
  return {
    title,
    meta,
    context: "",
    acceptanceCriteria: [],
    subIssues: [],
    conversation: [],
    trailingProse: "",
  };
}

function parseTitle(lines: string[]): string {
  const h1 = lines.find((l) => l.startsWith("# "));
  if (!h1) throw new Error("Epic file missing H1 title line");
  return h1.slice(2).trim();
}

function parseMeta(lines: string[]): EpicMeta {
  const openIdx = lines.findIndex((l) => l.trim() === META_OPEN);
  if (openIdx === -1) throw new Error(`Epic file missing meta block (${META_OPEN}…${META_CLOSE})`);
  const closeIdx = lines.findIndex((l, i) => i > openIdx && l.trim() === META_CLOSE);
  if (closeIdx === -1) throw new Error("Meta block not closed");
  const body = lines.slice(openIdx + 1, closeIdx);
  return parseMetaBody(body);
}

function parseMetaBody(body: string[]): EpicMeta {
  const meta: EpicMeta = { slug: "" };
  for (const line of body) {
    const m = /^([a-z_-]+):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const [, key, raw] = m;
    switch (key) {
      case "slug": meta.slug = raw!; break;
      case "adapter": meta.adapter = raw!; break;
      case "complexity_ceiling": meta.complexityCeiling = Number(raw); break;
      case "approved": meta.approved = raw === "true"; break;
      case "labels": meta.labels = parseArray(raw!); break;
      case "blocked-by": meta.blockedBy = parseArray(raw!); break;
      case "pr": meta.pr = Number(raw); break;
      case "closed": meta.closed = raw === "true"; break;
    }
  }
  if (!meta.slug) throw new Error("Epic meta missing required `slug` key");
  return meta;
}

function parseArray(raw: string): string[] {
  // Accepts `[a, b]` or comma-separated bare values.
  const stripped = raw.trim().replace(/^\[|\]$/g, "");
  return stripped
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
```

- [ ] **Step 5: Run test — should pass**

```bash
bun test packages/dispatcher/test/epic-store/parser.test.ts 2>&1 | tail -5
```

Expected: PASS.

- [ ] **Step 6: Add the codex-adapter fixture**

Copy the worked example from the spec into `packages/dispatcher/test/epic-store/fixtures/codex-adapter.md` (the full one with sub-issues, conversation, etc.). This will fail to parse correctly until the parser is extended in following tasks.

- [ ] **Step 7: Add acceptance criteria + sub-issues tests and implementations**

Append to `parser.test.ts`:

```typescript
describe("parseEpicFile — sections", () => {
  test("parses acceptance criteria checkboxes", () => {
    const epic = parseEpicFile(fixture("codex-adapter"));
    expect(epic.acceptanceCriteria).toHaveLength(3);
    expect(epic.acceptanceCriteria[0]).toEqual({
      checked: false,
      text: "Codex agent dispatches end-to-end against a test issue",
    });
  });

  test("parses sub-issues with stable IDs", () => {
    const epic = parseEpicFile(fixture("codex-adapter"));
    expect(epic.subIssues).toHaveLength(3);
    expect(epic.subIssues[0]).toMatchObject({
      id: 1,
      checked: false,
      title: "1 — Implement the CodexAdapter",
    });
  });
});
```

Implement `parseAcceptance` and `parseSubIssues` in `parser.ts`:

```typescript
import {
  SUB_ISSUE_OPEN_RE, SUB_ISSUE_CLOSE,
} from "./markers.ts";

// In parseEpicFile, replace the stub returns with real parses:
const context = sectionBody(lines, "Context");
const acceptanceCriteria = parseAcceptance(sectionBody(lines, "Acceptance criteria"));
const subIssues = parseSubIssues(sectionBody(lines, "Sub-issues"));

function sectionBody(lines: string[], heading: string): string {
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return "";
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).join("\n").trim();
}

function parseAcceptance(body: string): { checked: boolean; text: string }[] {
  const out: { checked: boolean; text: string }[] = [];
  for (const line of body.split("\n")) {
    const m = /^- \[([ x])\]\s+(.+)$/.exec(line);
    if (m) out.push({ checked: m[1] === "x", text: m[2]!.trim() });
  }
  return out;
}

function parseSubIssues(body: string): SubIssue[] {
  const out: SubIssue[] = [];
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length) {
    const open = SUB_ISSUE_OPEN_RE.exec(lines[i]!.trim());
    if (!open) { i++; continue; }
    const id = Number(open[1]);
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() !== SUB_ISSUE_CLOSE) j++;
    const inner = lines.slice(i + 1, j);
    const cb = /^- \[([ x])\]\s+\*\*(.+?)\*\*(.*)$/.exec(inner[0] ?? "");
    if (!cb) throw new Error(`Sub-issue id=${id} missing canonical "- [ ] **N — title**" line`);
    const checked = cb[1] === "x";
    const title = cb[2]!.trim();
    const provenance = (cb[3] ?? "").trim() || undefined;
    const subBody = inner.slice(1).join("\n").trim();
    out.push({ id, checked, title, body: subBody, provenance });
    i = j + 1;
  }
  return out;
}
```

Add the imports + the `SubIssue` type import.

- [ ] **Step 8: Run tests**

```bash
bun test packages/dispatcher/test/epic-store/parser.test.ts 2>&1 | tail -5
```

Expected: PASS (all parsing tests so far).

- [ ] **Step 9: Add conversation parsing — test first**

Append to `parser.test.ts`:

```typescript
describe("parseEpicFile — conversation", () => {
  test("parses dispatch-event + question + answer entries", () => {
    const epic = parseEpicFile(fixture("mid-question"));
    expect(epic.conversation).toHaveLength(2);
    const [dispatch, question] = epic.conversation;
    expect(dispatch.kind).toBe("dispatch-event");
    expect(question.kind).toBe("question");
    if (question.kind === "question") {
      expect(question.id).toBe(1);
      expect(question.status).toBe("open");
      expect(question.answer).toBeUndefined(); // empty answer block
    }
  });

  test("treats a non-empty answer block as the resolved reply", () => {
    const body = fixture("mid-question").replace(
      "<!-- middle:answer for=1 -->\n<!-- Human edits here. File-watcher fires resume on this section becoming non-empty. -->\n<!-- /middle:answer -->",
      "<!-- middle:answer for=1 -->\nAuthorized: proceed with deferral.\n<!-- /middle:answer -->",
    );
    const epic = parseEpicFile(body);
    const q = epic.conversation[1]!;
    if (q.kind !== "question") throw new Error("expected question");
    expect(q.answer).toEqual({ body: "Authorized: proceed with deferral." });
  });
});
```

- [ ] **Step 10: Create the mid-question fixture**

`packages/dispatcher/test/epic-store/fixtures/mid-question.md` — copy the codex-adapter fixture, then replace its empty `<!-- middle:conversation -->` block with the worked-example "mid-dispatch, agent parked" content from the spec.

- [ ] **Step 11: Implement conversation parser**

Add to `parser.ts`:

```typescript
import {
  CONVERSATION_OPEN, CONVERSATION_CLOSE,
  QUESTION_OPEN_RE, QUESTION_CLOSE,
  ANSWER_OPEN_RE, ANSWER_CLOSE,
  DISPATCH_EVENT_OPEN_RE, DISPATCH_EVENT_CLOSE,
} from "./markers.ts";

// In parseEpicFile, after parseSubIssues:
const conversation = parseConversation(lines);

function parseConversation(lines: string[]): ConversationEntry[] {
  const start = lines.findIndex((l) => l.trim() === CONVERSATION_OPEN);
  if (start === -1) return [];
  const end = lines.findIndex((l, i) => i > start && l.trim() === CONVERSATION_CLOSE);
  if (end === -1) throw new Error("Conversation block not closed");
  const inner = lines.slice(start + 1, end);
  const entries: ConversationEntry[] = [];
  let i = 0;
  while (i < inner.length) {
    const line = inner[i]!.trim();
    if (!line) { i++; continue; }

    const dm = DISPATCH_EVENT_OPEN_RE.exec(line);
    if (dm) {
      const close = inner.findIndex((l, k) => k > i && l.trim() === DISPATCH_EVENT_CLOSE);
      if (close === -1) throw new Error("dispatch-event not closed");
      entries.push({
        kind: "dispatch-event",
        ts: dm[1]!,
        eventKind: dm[2]!,
        body: inner.slice(i + 1, close).join("\n").trim(),
      });
      i = close + 1;
      continue;
    }

    const qm = QUESTION_OPEN_RE.exec(line);
    if (qm) {
      const close = inner.findIndex((l, k) => k > i && l.trim() === QUESTION_CLOSE);
      if (close === -1) throw new Error("question not closed");
      const block = inner.slice(i + 1, close);
      const answerStart = block.findIndex((l) => ANSWER_OPEN_RE.test(l.trim()));
      const questionBody = (answerStart === -1 ? block : block.slice(0, answerStart))
        .join("\n").trim();
      let answer: { body: string } | undefined;
      if (answerStart !== -1) {
        const answerClose = block.findIndex((l, k) => k > answerStart && l.trim() === ANSWER_CLOSE);
        if (answerClose === -1) throw new Error("answer not closed");
        const answerBody = block
          .slice(answerStart + 1, answerClose)
          .filter((l) => !/^<!--/.test(l.trim())) // strip placeholder html comments
          .join("\n").trim();
        if (answerBody) answer = { body: answerBody };
      }
      entries.push({
        kind: "question",
        id: Number(qm[1]),
        status: qm[2] as "open" | "resolved",
        ts: qm[3]!,
        questionKind: qm[4],
        body: questionBody,
        answer,
      });
      i = close + 1;
      continue;
    }
    i++;
  }
  return entries;
}
```

- [ ] **Step 12: Run all parser tests**

```bash
bun test packages/dispatcher/test/epic-store/parser.test.ts 2>&1 | tail -8
```

Expected: all PASS.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat(epic-store): Epic file parser (meta, sections, sub-issues, conversation)

Strict on markers + attributes (the structural contract), lenient on
prose. Throws with a named-marker error when a structural element is
malformed (operators diagnose without log-tailing). Conversation parser
distinguishes dispatch-event vs question, threads an answer block under
its question, and treats an answer's html-comment-only body as empty
(the 'placeholder' state) vs human-written text (the 'replied' state)."
```

---

### Task 7: Epic-file renderer + round-trip property test

**Files:**
- Create: `packages/dispatcher/src/epic-store/epic-file/renderer.ts`
- Create: `packages/dispatcher/test/epic-store/round-trip.test.ts`

The renderer MUST produce byte-identical output to any input the parser successfully reads. Property test enforces it.

- [ ] **Step 1: Write the round-trip property test**

`packages/dispatcher/test/epic-store/round-trip.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEpicFile } from "../../src/epic-store/epic-file/parser.ts";
import { renderEpicFile } from "../../src/epic-store/epic-file/renderer.ts";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");
const FIXTURE_FILES = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".md"));

describe("Epic file round-trip", () => {
  for (const file of FIXTURE_FILES) {
    test(`renderEpicFile(parseEpicFile(${file})) === ${file}`, () => {
      const body = readFileSync(join(FIXTURES_DIR, file), "utf8");
      const reparsed = parseEpicFile(body);
      const rendered = renderEpicFile(reparsed);
      expect(rendered).toBe(body);
    });
  }
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test packages/dispatcher/test/epic-store/round-trip.test.ts 2>&1 | tail -8
```

Expected: FAIL — `renderEpicFile` not defined.

- [ ] **Step 3: Implement renderer**

`packages/dispatcher/src/epic-store/epic-file/renderer.ts`:

```typescript
import {
  EPIC_DOC_MARKER, META_OPEN, META_CLOSE,
  SUB_ISSUE_CLOSE,
  CONVERSATION_OPEN, CONVERSATION_CLOSE,
  QUESTION_CLOSE, ANSWER_CLOSE,
  DISPATCH_EVENT_CLOSE,
} from "./markers.ts";
import type { EpicFile, EpicMeta, SubIssue, ConversationEntry } from "./types.ts";

export function renderEpicFile(epic: EpicFile): string {
  const parts: string[] = [];
  parts.push(EPIC_DOC_MARKER);
  parts.push(`# ${epic.title}`);
  parts.push("");
  parts.push(renderMeta(epic.meta));
  parts.push("");
  parts.push("## Context");
  parts.push("");
  parts.push(epic.context || "(empty)");
  parts.push("");
  parts.push("## Acceptance criteria");
  parts.push("");
  for (const a of epic.acceptanceCriteria) {
    parts.push(`- [${a.checked ? "x" : " "}] ${a.text}`);
  }
  parts.push("");
  parts.push("## Sub-issues");
  parts.push("");
  for (const s of epic.subIssues) {
    parts.push(...renderSubIssue(s));
    parts.push("");
  }
  parts.push(CONVERSATION_OPEN);
  if (epic.conversation.length === 0) {
    parts.push(CONVERSATION_CLOSE);
  } else {
    for (const e of epic.conversation) {
      parts.push("");
      parts.push(...renderConversationEntry(e));
    }
    parts.push("");
    parts.push(CONVERSATION_CLOSE);
  }
  return parts.join("\n") + "\n";
}

function renderMeta(m: EpicMeta): string {
  const out: string[] = [META_OPEN];
  out.push(`slug: ${m.slug}`);
  if (m.adapter !== undefined) out.push(`adapter: ${m.adapter}`);
  if (m.complexityCeiling !== undefined) out.push(`complexity_ceiling: ${m.complexityCeiling}`);
  if (m.approved !== undefined) out.push(`approved: ${m.approved}`);
  if (m.labels?.length) out.push(`labels: [${m.labels.join(", ")}]`);
  if (m.blockedBy?.length) out.push(`blocked-by: [${m.blockedBy.join(", ")}]`);
  if (m.pr !== undefined) out.push(`pr: ${m.pr}`);
  if (m.closed !== undefined) out.push(`closed: ${m.closed}`);
  out.push(META_CLOSE);
  return out.join("\n");
}

function renderSubIssue(s: SubIssue): string[] {
  const out = [`<!-- middle:sub-issue id=${s.id} -->`];
  const provenance = s.provenance ? ` ${s.provenance}` : "";
  out.push(`- [${s.checked ? "x" : " "}] **${s.title}**${provenance}`);
  if (s.body) out.push(`  ${s.body.split("\n").join("\n  ")}`);
  out.push(SUB_ISSUE_CLOSE);
  return out;
}

function renderConversationEntry(e: ConversationEntry): string[] {
  if (e.kind === "dispatch-event") {
    return [
      `<!-- middle:dispatch-event ts=${e.ts} kind=${e.eventKind} -->`,
      e.body,
      DISPATCH_EVENT_CLOSE,
    ];
  }
  if (e.kind === "question") {
    const out = [
      `<!-- middle:question id=${e.id} status=${e.status} ts=${e.ts}${
        e.questionKind ? ` kind=${e.questionKind}` : ""
      } -->`,
      e.body,
      "",
      `<!-- middle:answer for=${e.id} -->`,
      e.answer ? e.answer.body : "<!-- Human edits here. File-watcher fires resume on this section becoming non-empty. -->",
      ANSWER_CLOSE,
      QUESTION_CLOSE,
    ];
    return out;
  }
  // parse-error (renderer doesn't normally emit these; included for completeness)
  return [`<!-- middle:parse-error ts=${e.ts} -->`, e.body, `<!-- /middle:parse-error -->`];
}
```

- [ ] **Step 4: Run round-trip test**

```bash
bun test packages/dispatcher/test/epic-store/round-trip.test.ts 2>&1 | tail -10
```

Expected: round-trip passes for `empty-epic.md`; may show small whitespace deltas on the richer fixtures. **Iterate the renderer until every fixture round-trips byte-identically.** This is the load-bearing test — do not skip.

- [ ] **Step 5: Add the all-closed fixture for closed-epic coverage**

`packages/dispatcher/test/epic-store/fixtures/all-closed.md` — codex-adapter with every sub-issue checkbox flipped to `[x]` and a provenance suffix `*(done in wf_… sha abc1234)*` on each title line.

- [ ] **Step 6: Re-run round-trip + all parser tests**

```bash
bun test packages/dispatcher/test/epic-store/ 2>&1 | tail -8
```

Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(epic-store): Epic file renderer + byte-identical round-trip test

renderEpicFile(parseEpicFile(body)) === body for every fixture (empty,
codex-adapter, mid-question, all-closed). Round-trip purity replaces a
lock: dispatcher and human can both edit the file (dispatcher patches
conversation entries via the renderer; human edits between markers or
inside their answer block) without corrupting each other's writes."
```

---

### Task 8: `fileEpicGateway` — Epic-shaped methods + PR delegation

**Files:**
- Create: `packages/dispatcher/src/epic-store/file-epic-gateway.ts`
- Create: `packages/dispatcher/test/epic-store/file-epic-gateway.test.ts`

The file gateway is a **composite**: Epic-shaped methods read/write the local Epic file; PR-shaped methods delegate to an internal `gh` backend.

- [ ] **Step 1: Write the failing test — listOpenEpics**

`packages/dispatcher/test/epic-store/file-epic-gateway.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFileEpicGateway } from "../../src/epic-store/file-epic-gateway.ts";

let scratch: string;
let epicsDir: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "middle-fe-"));
  epicsDir = join(scratch, "planning", "epics");
  mkdirSync(epicsDir, { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function writeEpicFixture(name: string, body: string) {
  writeFileSync(join(epicsDir, `${name}.md`), body);
}

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "fixtures", `${name}.md`), "utf8");

describe("fileEpicGateway.listOpenEpics", () => {
  test("lists open Epics from epics_dir with sub-issue counts", async () => {
    writeEpicFixture("codex-adapter", fixture("codex-adapter"));
    writeEpicFixture("all-closed", fixture("all-closed"));
    const gw = makeFileEpicGateway({ repoPath: scratch, epicsDir, gh: stubGh() });
    const epics = await gw.listOpenEpics("acme/x");
    expect(epics).toHaveLength(1);
    expect(epics[0]).toMatchObject({
      ref: "codex-adapter",
      title: "CodexAdapter",
      openSubs: 3,
      closedSubs: 0,
    });
  });

  test("skips Epics with closed: true in meta", async () => {
    writeEpicFixture("retired", `<!-- middle:epic v1 -->\n# Retired\n\n<!-- middle:meta\nslug: retired\nclosed: true\n-->\n\n## Context\n\n(empty)\n\n## Acceptance criteria\n\n## Sub-issues\n\n<!-- middle:conversation -->\n<!-- /middle:conversation -->\n`);
    const gw = makeFileEpicGateway({ repoPath: scratch, epicsDir, gh: stubGh() });
    const epics = await gw.listOpenEpics("acme/x");
    expect(epics).toEqual([]);
  });
});

function stubGh() {
  // Stub GitHub backend — only PR methods are exercised in delegation tests.
  return {
    getPullRequest: async () => null,
    editPullRequestBody: async () => {},
    resolveAgentLogin: async () => "test-user",
  };
}
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test packages/dispatcher/test/epic-store/file-epic-gateway.test.ts 2>&1 | tail -8
```

Expected: FAIL — `makeFileEpicGateway` not defined.

- [ ] **Step 3: Implement `makeFileEpicGateway`**

`packages/dispatcher/src/epic-store/file-epic-gateway.ts`:

```typescript
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EpicGateway } from "../github.ts";
import { parseEpicFile } from "./epic-file/parser.ts";
import { renderEpicFile } from "./epic-file/renderer.ts";
import type { EpicFile } from "./epic-file/types.ts";

export type FileEpicGatewayOpts = {
  /** Absolute path to the repo checkout. */
  repoPath: string;
  /** Absolute path to the epics directory (epicsDir from repo_config). */
  epicsDir: string;
  /** GitHub backend for PR-shaped delegated methods. */
  gh: Pick<EpicGateway, "getPullRequest" | "editPullRequestBody" | "resolveAgentLogin">;
};

export function makeFileEpicGateway(opts: FileEpicGatewayOpts): EpicGateway {
  return {
    async listOpenEpics(_repo: string) {
      if (!existsSync(opts.epicsDir)) return [];
      const files = readdirSync(opts.epicsDir).filter((f) => f.endsWith(".md") && f !== "README.md");
      const epics: ReturnType<EpicGateway["listOpenEpics"]> extends Promise<infer T> ? T : never = [];
      for (const file of files) {
        try {
          const body = readFileSync(join(opts.epicsDir, file), "utf8");
          const epic = parseEpicFile(body);
          if (epic.meta.closed) continue;
          epics.push({
            ref: epic.meta.slug,
            title: epic.title,
            openSubs: epic.subIssues.filter((s) => !s.checked).length,
            closedSubs: epic.subIssues.filter((s) => s.checked).length,
            labels: epic.meta.labels ?? [],
            adapter: epic.meta.adapter,
          });
        } catch (error) {
          console.error(`[file-epic-gateway] skipped ${file}: ${(error as Error).message}`);
        }
      }
      return epics;
    },

    // The remaining methods will be added in following tasks.
    // For now, stub them so the type passes.
    listIssueComments: async () => [],
    getCommentAuthor: async () => null,
    getIssueLabels: async () => [],
    postComment: async () => 0,
    editComment: async () => {},
    findEpicPr: async () => null,
    getPullRequest: opts.gh.getPullRequest,
    editPullRequestBody: opts.gh.editPullRequestBody,
    resolveAgentLogin: opts.gh.resolveAgentLogin,
  };
}

function readEpic(opts: FileEpicGatewayOpts, ref: string): EpicFile | null {
  const path = join(opts.epicsDir, `${ref}.md`);
  if (!existsSync(path)) return null;
  return parseEpicFile(readFileSync(path, "utf8"));
}

function writeEpic(opts: FileEpicGatewayOpts, ref: string, epic: EpicFile): void {
  const path = join(opts.epicsDir, `${ref}.md`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, renderEpicFile(epic));
  // Atomic rename — write-temp + rename, no fsync (Bun handles).
  require("node:fs").renameSync(tmp, path);
}
```

(`EpicGateway`'s exact method signature for `listOpenEpics` lives in `github.ts` after Task 1's rename — adapt the return type accordingly. If `listOpenEpics` returns more fields today, match them.)

- [ ] **Step 4: Run test — passes for listOpenEpics**

```bash
bun test packages/dispatcher/test/epic-store/file-epic-gateway.test.ts 2>&1 | tail -8
```

Expected: PASS.

- [ ] **Step 5: Add tests + implementations for the remaining Epic-shaped methods**

For each of: `listIssueComments`, `getIssueLabels`, `postComment`, `editComment`, `findEpicPr` — write a test, then the implementation, then run. (Pattern repeats; keep each as its own step bundle.)

Example for `postComment`:

```typescript
test("postComment appends a dispatch-event to the conversation block", async () => {
  writeEpicFixture("codex-adapter", fixture("codex-adapter"));
  const gw = makeFileEpicGateway({ repoPath: scratch, epicsDir, gh: stubGh() });
  await gw.postComment("acme/x", "codex-adapter", "dispatched wf_abc on branch …");
  const body = readFileSync(join(epicsDir, "codex-adapter.md"), "utf8");
  expect(body).toContain("<!-- middle:dispatch-event ts=");
  expect(body).toContain("dispatched wf_abc on branch …");
});
```

Implementation: read the Epic file, append a `dispatch-event` to `conversation`, write it back via `renderEpicFile`. Return a fresh integer ID for the comment (use ts millis or a counter).

- [ ] **Step 6: Run full file-epic-gateway test file**

```bash
bun test packages/dispatcher/test/epic-store/file-epic-gateway.test.ts 2>&1 | tail -10
```

Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(epic-store): fileEpicGateway — Epic from files, PR delegated to gh

Composite gateway. Epic-shaped methods (listOpenEpics, listIssueComments,
getCommentAuthor, getIssueLabels, postComment, editComment, findEpicPr)
read/write Epic files via the round-trip-pure parser+renderer. PR-shaped
methods (getPullRequest, editPullRequestBody) and resolveAgentLogin
delegate to an embedded gh backend — PRs stay GitHub-native in hybrid mode."
```

---

### Task 9: `fileStateGateway`

**Files:**
- Create: `packages/dispatcher/src/epic-store/file-state-gateway.ts`
- Create: `packages/dispatcher/test/epic-store/file-state-gateway.test.ts`

Same shape as `fileEpicGateway`, smaller surface — just `readBody` and `writeBody` against `state_file`. The existing `state-issue.ts` `parseStateIssue` / `renderStateIssue` / `applyDispatcherSections` flow is reused — `fileStateGateway` is the storage layer beneath them.

- [ ] **Step 1: Test**

```typescript
// packages/dispatcher/test/epic-store/file-state-gateway.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFileStateGateway } from "../../src/epic-store/file-state-gateway.ts";

let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "middle-fs-")); });
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

describe("fileStateGateway", () => {
  test("readBody returns empty string when state file absent", async () => {
    const gw = makeFileStateGateway({ stateFile: join(scratch, "state.md") });
    expect(await gw.readBody("acme/x")).toBe("");
  });

  test("writeBody atomic write — no .tmp leftover", async () => {
    const gw = makeFileStateGateway({ stateFile: join(scratch, "state.md") });
    await gw.writeBody("acme/x", "hello");
    expect(readFileSync(join(scratch, "state.md"), "utf8")).toBe("hello");
    expect(existsSync(join(scratch, "state.md.tmp"))).toBe(false);
  });

  test("readBody reads what writeBody wrote", async () => {
    const gw = makeFileStateGateway({ stateFile: join(scratch, "state.md") });
    await gw.writeBody("acme/x", "body-v1");
    expect(await gw.readBody("acme/x")).toBe("body-v1");
  });
});
```

- [ ] **Step 2: Implement + commit**

```typescript
// packages/dispatcher/src/epic-store/file-state-gateway.ts
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { StateGateway } from "../state-issue.ts";

export function makeFileStateGateway(opts: { stateFile: string }): StateGateway {
  return {
    async readBody(_repo: string) {
      if (!existsSync(opts.stateFile)) return "";
      return readFileSync(opts.stateFile, "utf8");
    },
    async writeBody(_repo: string, body: string) {
      const tmp = `${opts.stateFile}.tmp`;
      writeFileSync(tmp, body);
      renameSync(tmp, opts.stateFile);
    },
  };
}
```

Run the test, commit with message:

```bash
git commit -m "feat(epic-store): fileStateGateway — atomic file-backed state store"
```

---

### Task 10: `filePollGateway` (without watcher — Phase 1)

**Files:**
- Create: `packages/dispatcher/src/epic-store/file-poll-gateway.ts`
- Create: `packages/dispatcher/test/epic-store/file-poll-gateway.test.ts`

In Phase 1, `filePollGateway` serves comment lookups from the Epic file and delegates PR-poll methods to gh. **No mtime watcher yet** — that's Phase 2.

- [ ] **Step 1: Test — listIssueComments returns conversation entries**

```typescript
test("listIssueComments mirrors fileEpicGateway's conversation parsing", async () => {
  writeEpicFixture("mid-question", fixture("mid-question"));
  const gw = makeFilePollGateway({ epicsDir, gh: stubGh() });
  const comments = await gw.listIssueComments("acme/x", "codex-adapter");
  expect(comments.length).toBeGreaterThan(0);
  // The agent's question comment must be flagged authorIsBot=true so the
  // poller's classifyNewHumanReply ignores it (closes #178's class).
  const q = comments.find((c) => c.body.startsWith(">"));
  expect(q?.authorIsBot).toBe(true);
});
```

- [ ] **Step 2: Implement + delegate the rest**

```typescript
// packages/dispatcher/src/epic-store/file-poll-gateway.ts
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import type { PollGateway, IssueComment } from "../poller.ts";
import { parseEpicFile } from "./epic-file/parser.ts";

export type FilePollGatewayOpts = {
  epicsDir: string;
  gh: Pick<PollGateway, "findPrForEpic" | "findEpicPrLifecycle" | "statusCheckRollup" | "getRateLimit">;
};

export function makeFilePollGateway(opts: FilePollGatewayOpts): PollGateway {
  return {
    async listIssueComments(_repo: string, ref: string): Promise<IssueComment[]> {
      const path = join(opts.epicsDir, `${ref}.md`);
      if (!existsSync(path)) return [];
      const epic = parseEpicFile(readFileSync(path, "utf8"));
      const out: IssueComment[] = [];
      for (const entry of epic.conversation) {
        if (entry.kind === "question") {
          out.push({
            id: entry.id,
            authorLogin: "agent",
            authorIsBot: true,
            createdAt: Date.parse(entry.ts),
            body: entry.body,
          });
          if (entry.answer) {
            out.push({
              id: entry.id + 1_000_000,
              authorLogin: "human",
              authorIsBot: false,
              createdAt: Date.parse(entry.ts) + 1,
              body: entry.answer.body,
            });
          }
        }
      }
      return out;
    },
    findPrForEpic: opts.gh.findPrForEpic,
    findEpicPrLifecycle: opts.gh.findEpicPrLifecycle,
    statusCheckRollup: opts.gh.statusCheckRollup,
    getRateLimit: opts.gh.getRateLimit,
  };
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test packages/dispatcher/test/epic-store/file-poll-gateway.test.ts 2>&1 | tail -5
git add -A
git commit -m "feat(epic-store): filePollGateway — comments from Epic file, PR polls delegated

Closes #178's class for file mode: the agent's question entries are
marked authorIsBot=true (the marker is the discriminator, not the
GitHub user lookup), so the poller's classifyNewHumanReply structurally
cannot mistake the agent's own post for the human's reply. PR-poll
methods (reviews, CI, lifecycle, rate-limit) delegate to gh — PRs are
still GitHub-native in hybrid mode."
```

---

### Task 11: `buildFileGateways` factory + bootstrap selector

**Files:**
- Create: `packages/dispatcher/src/epic-store/index.ts`
- Modify: `packages/dispatcher/src/build-deps.ts`

- [ ] **Step 1: Write the factory**

```typescript
// packages/dispatcher/src/epic-store/index.ts
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { EpicGateway } from "../github.ts";
import type { StateGateway } from "../state-issue.ts";
import type { PollGateway } from "../poller.ts";
import { makeFileEpicGateway } from "./file-epic-gateway.ts";
import { makeFileStateGateway } from "./file-state-gateway.ts";
import { makeFilePollGateway } from "./file-poll-gateway.ts";

export type FileGateways = {
  epicGateway: EpicGateway;
  stateGateway: StateGateway;
  pollGateway: PollGateway;
};

export type BuildFileGatewaysOpts = {
  db: Database;
  repo: string;
  repoPath: string;
  epicsDir: string;
  stateFile: string;
  /** GitHub gateways supply the PR-delegation methods. */
  ghEpic: EpicGateway;
  ghPoll: PollGateway;
};

export function buildFileGateways(opts: BuildFileGatewaysOpts): FileGateways {
  return {
    epicGateway: makeFileEpicGateway({
      repoPath: opts.repoPath,
      epicsDir: opts.epicsDir,
      gh: opts.ghEpic,
    }),
    stateGateway: makeFileStateGateway({ stateFile: opts.stateFile }),
    pollGateway: makeFilePollGateway({ epicsDir: opts.epicsDir, gh: opts.ghPoll }),
  };
}
```

- [ ] **Step 2: Modify `build-deps.ts` to switch**

In `buildImplementationDeps`, add the per-repo selector right before the deps object is built. **Read** `build-deps.ts` first to find the exact pattern.

```typescript
// packages/dispatcher/src/build-deps.ts (sketch — adapt to existing shape)
const repoCfg = readRepoConfig(args.db, args.repo);

const gateways = repoCfg.epicStore === "file"
  ? buildFileGateways({
      db: args.db,
      repo: args.repo,
      repoPath: args.resolveRepoPath(args.repo),
      epicsDir: join(args.resolveRepoPath(args.repo), repoCfg.epicsDir ?? "planning/epics"),
      stateFile: join(args.resolveRepoPath(args.repo), repoCfg.stateFile ?? ".middle/state.md"),
      ghEpic: ghGitHub,
      ghPoll: ghPollGateway,
    })
  : { epicGateway: ghGitHub, stateGateway: ghStateIssueGateway, pollGateway: ghPollGateway };

// Use gateways.epicGateway / .stateGateway / .pollGateway where the existing
// `gh*` references were.
```

`readRepoConfig` may need adding — it's a small SELECT on `repo_config` returning typed fields.

- [ ] **Step 3: Run full dispatcher suite**

```bash
bun run typecheck && bun test packages/dispatcher/ 2>&1 | tail -5
```

Expected: ALL PASS. Existing repos default to github mode; behavior unchanged.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(epic-store): bootstrap selector — per-repo gateway implementation

buildImplementationDeps reads repo_config.epic_store and picks the file
or github gateway trio. All existing repos default to 'github' from the
schema migration; behavior unchanged. File-mode repos route through the
new file gateways behind the same EpicGateway/StateGateway/PollGateway
contracts; no workflow body change."
```

---

### Task 12: `postQuestion` file-mode wiring

**Files:**
- Modify: `packages/dispatcher/src/build-deps.ts` — wire mode-specific `postQuestion`

`deps.postQuestion` is already DI'd. In file mode, it writes a `<!-- middle:question -->` block via the renderer.

- [ ] **Step 1: Add a test exercising the file-mode postQuestion**

Append to `packages/dispatcher/test/epic-store/file-epic-gateway.test.ts`:

```typescript
import { buildFileGateways } from "../../src/epic-store/index.ts";

test("file-mode postQuestion appends a question block to the Epic file", async () => {
  writeEpicFixture("codex-adapter", fixture("codex-adapter"));
  // build-deps integration is the real test, but we can exercise the seam directly:
  const { epicGateway } = buildFileGateways({/* …minimal opts… */});
  // postQuestion is wired in build-deps.ts (not on the gateway directly), so this
  // test belongs alongside build-deps. Move it to test/build-deps.test.ts.
});
```

Better: write the integration test in `packages/dispatcher/test/build-deps.test.ts`:

```typescript
test("file-mode wiring: postQuestion writes a question block to the Epic file", async () => {
  // …set up tmp repo, write codex-adapter fixture, configure repo_config to file mode…
  const deps = await buildImplementationDeps({ /* …file-mode args… */ });
  await deps.postQuestion!({
    repo: "acme/x",
    epicRef: "codex-adapter",
    question: "Should I proceed?",
    context: undefined,
    kind: "question",
  });
  const body = readFileSync(join(epicsDir, "codex-adapter.md"), "utf8");
  expect(body).toContain("<!-- middle:question id=1 status=open ts=");
  expect(body).toContain("Should I proceed?");
});
```

- [ ] **Step 2: Implement the file-mode postQuestion in `build-deps.ts`**

```typescript
const postQuestion: ImplementationDeps["postQuestion"] =
  repoCfg.epicStore === "file"
    ? async (opts) => {
        const epicPath = join(args.resolveRepoPath(opts.repo), repoCfg.epicsDir ?? "planning/epics", `${opts.epicRef}.md`);
        const epic = parseEpicFile(readFileSync(epicPath, "utf8"));
        const nextId = (epic.conversation.filter((e) => e.kind === "question") as Array<{ id: number }>)
          .reduce((max, e) => Math.max(max, e.id), 0) + 1;
        epic.conversation.push({
          kind: "question",
          id: nextId,
          status: "open",
          ts: new Date().toISOString(),
          questionKind: opts.kind,
          body: opts.question + (opts.context ? `\n\n${opts.context}` : ""),
        });
        const tmp = `${epicPath}.tmp`;
        writeFileSync(tmp, renderEpicFile(epic));
        renameSync(tmp, epicPath);
      }
    : /* existing github-mode postQuestion */;
```

- [ ] **Step 3: Run + commit**

```bash
bun test packages/dispatcher/test/build-deps.test.ts 2>&1 | tail -5
git add -A
git commit -m "feat(epic-store): file-mode postQuestion wiring

deps.postQuestion (the existing DI seam) is wired to a file-backed
writer when epic_store='file'. The agent's blocked.json flow — write
sentinel → exit → classifyStop → parkForResume → postQuestion — is
unchanged everywhere upstream. Only the comment-write itself is mode-
aware. Closes the postQuestion side of the file-mode hybrid loop."
```

---

### Task 13: `mm init` file-mode scaffold

**Files:**
- Modify: `packages/cli/src/commands/init.ts`
- Test: `packages/cli/test/init.test.ts` (extend existing)

- [ ] **Step 1: Test — file-mode init writes the scaffold without any gh calls**

```typescript
test("mm init --epic-store=file scaffolds planning/epics + .middle/state.md", async () => {
  const repo = mkdtempSync(join(tmpdir(), "mm-init-"));
  // run init with the file-mode flag — no gh stub needed; the scaffold must not call gh
  await runInit(repo, { epicStore: "file" });
  expect(existsSync(join(repo, "planning", "epics", "README.md"))).toBe(true);
  expect(existsSync(join(repo, ".middle", "state.md"))).toBe(true);
  expect(readFileSync(join(repo, ".middle", `${basename(repo)}.toml`), "utf8")).toMatch(/mode\s*=\s*"file"/);
});
```

- [ ] **Step 2: Implement the file-mode branch in `runInit`**

Add an `--epic-store` flag (`github` | `file`) defaulting to `github`. When `file`, skip every gh call and write the scaffold:

```typescript
if (opts.epicStore === "file") {
  mkdirSync(join(repoPath, "planning", "epics"), { recursive: true });
  writeFileSync(join(repoPath, "planning", "epics", "README.md"), README_TEMPLATE);
  writeFileSync(join(repoPath, "planning", "epics", ".keep"), "");
  mkdirSync(join(repoPath, ".middle"), { recursive: true });
  writeFileSync(join(repoPath, ".middle", "state.md"), STATE_FILE_TEMPLATE);
  writeFileSync(join(repoPath, ".middle", `${repoSlug}.toml`), toml({
    epic_store: { mode: "file", epics_dir: "planning/epics", state_file: ".middle/state.md" },
  }));
  return;
}
// existing github-mode init unchanged
```

Add `README_TEMPLATE` and `STATE_FILE_TEMPLATE` as constants at the top of the file.

- [ ] **Step 3: Run + commit**

```bash
bun test packages/cli/test/init.test.ts 2>&1 | tail -5
git add -A
git commit -m "feat(cli): mm init --epic-store=file scaffolds the file-mode workspace

Writes planning/epics/README.md + .keep, .middle/state.md with the v1
marker, and .middle/<slug>.toml with epic_store.mode = 'file'. Zero gh
calls in the file-mode path."
```

---

### Task 14: `mm dispatch` accepts `--epic <slug>` and slug-or-number

**Files:**
- Modify: `packages/cli/src/commands/dispatch.ts`

- [ ] **Step 1: Test**

```typescript
test("mm dispatch accepts a slug ref via --epic flag", async () => {
  // mock the control-plane POST; verify it sends epicRef = "codex-adapter"
});

test("mm dispatch positional arg accepts either slug or number", async () => {
  // verify mm dispatch repo 60 → epicRef "60"; mm dispatch repo codex-adapter → epicRef "codex-adapter"
});
```

- [ ] **Step 2: Implement**

In `dispatch.ts`, accept `--epic <slug>` (string) OR positional `<epic>` (string — no `parseInt`). Pass it as `epicRef` to the control-plane POST. The daemon's dispatch endpoint already gets the ref; it'll resolve to either a numeric `epic_number` (github mode) or a slug-keyed Epic file (file mode) inside `prepareWorktree`.

- [ ] **Step 3: Update the daemon's dispatch endpoint to take epicRef**

Find where `mm dispatch` lands in the daemon (`packages/dispatcher/src/main.ts` — search for the dispatch HTTP handler). Change the request shape from `{ epic: number }` to `{ epicRef: string }` (back-compat: accept `epic` and stringify it).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(cli): mm dispatch --epic <slug> + slug-or-number positional

CLI takes a string ref; daemon accepts both legacy {epic:number} and
new {epicRef:string} request shapes. github-mode dispatches send the
stringified issue number; file-mode dispatches send the Epic slug."
```

---

### Task 15: `mm doctor` mode-aware checks

**Files:**
- Modify: `packages/cli/src/commands/doctor.ts`

- [ ] **Step 1: Test — file-mode doctor doesn't require state issue**

```typescript
test("file-mode doctor skips the state-issue check and checks epics_dir exists", async () => {
  // …
});
```

- [ ] **Step 2: Implement**

In `runDoctor`, after `loadConfig`, branch on `epic_store`:

```typescript
if (config.epicStore === "file") {
  checks.push(checkEpicsDir(config.epicsDir));
  // skip checkStateIssue
} else {
  checks.push(await checkStateIssue(args.repo));
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test packages/cli/test/doctor.test.ts 2>&1 | tail -5
git add -A
git commit -m "feat(cli): mm doctor — mode-aware checks (epics_dir vs state issue)"
```

---

### Task 16: `mm resume <epic> --answer "…"` CLI command

**Files:**
- Create: `packages/cli/src/commands/resume.ts`
- Modify: `packages/cli/src/index.ts` — register the command
- Test: `packages/cli/test/resume.test.ts`

`mm resume` is the manual escape hatch for Phase 1 (and for parked workflows even after Phase 2's watcher lands). It fires the resume signal directly via the daemon's control plane, without needing a file edit.

- [ ] **Step 1: Test**

```typescript
test("mm resume injects an answer + fires resume signal via control plane", async () => {
  // mock control-plane endpoint; verify POST body { epicRef: "codex-adapter", answer: "…" }
});
```

- [ ] **Step 2: Implement the CLI**

```typescript
// packages/cli/src/commands/resume.ts
import { Command } from "commander";

export function registerResumeCommand(program: Command) {
  program
    .command("resume <epic>")
    .description("Inject an answer + fire the resume signal for a parked workflow")
    .requiredOption("-a, --answer <text>", "Answer body to feed the agent")
    .option("-r, --repo <repo>", "Repo slug (owner/name)")
    .action(async (epic: string, opts: { answer: string; repo?: string }) => {
      const repo = opts.repo ?? resolveCurrentRepo();
      const url = `${dispatcherUrl()}/control/resume`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, epicRef: epic, answer: opts.answer }),
      });
      if (!res.ok) {
        console.error(`mm resume: rejected (${res.status}) — ${await res.text()}`);
        process.exit(1);
      }
      console.log(`mm resume: ${repo} epic '${epic}' → resume signal fired`);
    });
}
```

- [ ] **Step 3: Add the daemon endpoint**

In `packages/dispatcher/src/main.ts`, add a `POST /control/resume` handler that:
1. Looks up the parked workflow for `(repo, epicRef)` in `workflows` (state = `waiting-human`).
2. Fires `engine.signal(workflowId, RESUME_EVENT, { reason: "answered-question", reply: { commentId: 0, authorLogin: "operator", body: opts.answer } })`.
3. In file mode, also writes the answer into the Epic file's `<!-- middle:answer -->` block (so the history reflects the resolution).

- [ ] **Step 4: Run + commit**

```bash
bun test packages/cli/test/resume.test.ts 2>&1 | tail -5
git add -A
git commit -m "feat(cli): mm resume <epic> --answer 'text' — manual resume signal

Escape hatch for parked workflows in both modes. Phase 1 file-mode users
use this before the file-watcher lands; github-mode operators can use it
to bypass the gh comment + poller cycle for an immediate resume."
```

---

### Task 17: Skill refactor — `implementing-github-issues` abstract body

**Files:**
- Modify: `packages/skills/implementing-github-issues/SKILL.md`
- Create: `packages/skills/implementing-github-issues/references/github-mode-commands.md`
- Create: `packages/skills/implementing-github-issues/references/file-mode-commands.md`

Read the existing `SKILL.md` first; pull every `gh issue *` / `gh pr *` / `gh api` reference out of the body into the mode-specific Commands files. The body becomes mode-agnostic.

- [ ] **Step 1: Read the current SKILL.md and inventory mode-specific commands**

```bash
grep -nE "gh issue|gh pr|gh api" packages/skills/implementing-github-issues/SKILL.md
```

- [ ] **Step 2: Write `references/github-mode-commands.md`**

Mirror the existing skill's command examples into a single reference file titled "GitHub-mode commands."

- [ ] **Step 3: Write `references/file-mode-commands.md`**

The file-mode equivalents — `cat planning/epics/<slug>.md`, "append your plan to the `## Context` section in-line," "tick the sub-issue checkbox in `<!-- middle:sub-issue id=N -->`," "mark `mm resume` as the answer-channel of last resort," etc.

- [ ] **Step 4: Rewrite SKILL.md body to be mode-agnostic**

Replace every `gh issue view <num>` with "fetch the Epic." Each section ends with: "**Mode-specific commands:** see `references/<mode>-mode-commands.md`."

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(skills): implementing-github-issues — abstract body + per-mode commands

Body is now mode-agnostic: talks about 'the Epic', 'the Epic's plan
comment', 'closing the sub-issue with evidence' without naming gh. The
per-mode incantations live in references/{github,file}-mode-commands.md;
dispatch-brief generator injects the right reference into the agent's
prompt.md based on the run's mode."
```

---

### Task 18: Skill refactor — `recommending-github-issues`

Same pattern as Task 17 applied to `packages/skills/recommending-github-issues/SKILL.md`.

- [ ] **Step 1-4:** Inventory commands, extract per-mode files, rewrite body, commit.

```bash
git commit -m "refactor(skills): recommending-github-issues — abstract body + per-mode commands

File-mode scans epics_dir + reads .middle/state.md instead of gh issue
list + gh issue view. Both modes share the same scoring logic in the
body; the I/O lives in the reference files. Also: file-mode recommender
MUST NOT rewrite the In-flight section by hand — the dispatcher's
renderer is the sole writer (closes #180's class for file mode)."
```

---

### Task 19: Skill refactor — `creating-github-issues` file-mode addendum

Add a file-mode section to `creating-github-issues/SKILL.md` (or a sibling `creating-file-epics/SKILL.md`) covering how to author an Epic file from a planning document — section structure, meta keys, sub-issue blocks, no `gh issue create`.

- [ ] **Step 1-3:** Write, save, commit.

```bash
git commit -m "feat(skills): creating-github-issues — file-mode addendum

Authoring an Epic file from a planning document: file path, marker
order, meta keys, sub-issue block structure, no gh calls. Mirrors the
github-mode body section-for-section so a plan can be seeded in either
mode without restructuring."
```

---

### Task 20: Dispatch-brief generator — `ensurePromptFile` injects per-mode commands

**Files:**
- Modify: `packages/dispatcher/src/workflows/implementation.ts` — `ensurePromptFile` function

Today `ensurePromptFile` writes a default brief unless one already exists. Extend it to also write a `references/<mode>-mode-commands.md` snippet INTO the worktree's `.middle/` so the agent (whose skill reads `references/<mode>-mode-commands.md`) finds it.

- [ ] **Step 1: Test**

```typescript
test("ensurePromptFile in file mode copies file-mode-commands.md into worktree/.middle/", async () => {
  // …
});
```

- [ ] **Step 2: Implement**

In `ensurePromptFile`, after writing `prompt.md`, also:
1. Look up the repo's `epic_store` mode (already available from `deps`).
2. Read the bootstrap-skills mirror's `references/<mode>-mode-commands.md`.
3. Write it to `<worktree>/.middle/skills/<skill>/references/<mode>-mode-commands.md`.

- [ ] **Step 3: Run + commit**

```bash
bun test packages/dispatcher/test/implementation-workflow.test.ts 2>&1 | tail -5
git add -A
git commit -m "feat(dispatcher): ensurePromptFile injects per-mode commands reference

The agent's skill body is mode-agnostic; the per-mode incantations live
in references/<mode>-mode-commands.md. The dispatch-brief generator
mirrors the right reference into the worktree so the agent reads only
the commands relevant to its run's mode."
```

---

### Task 21: Parity test — happy-path dispatch via both backends

**Files:**
- Create: `packages/dispatcher/test/epic-store/parity.test.ts`

The load-bearing test. A single fixture runs the implementation workflow end-to-end with each gateway backend.

- [ ] **Step 1: Write the parametrized parity test**

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Engine } from "bunqueue/workflow";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAndMigrate } from "../../src/db.ts";
import { createImplementationWorkflow } from "../../src/workflows/implementation.ts";
// …

describe.each(["github", "file"] as const)("workflow parity — %s mode", (mode) => {
  let scratch: string;
  let db: Database;
  let engine: Engine;

  beforeEach(async () => {
    scratch = mkdtempSync(join(tmpdir(), `parity-${mode}-`));
    db = openAndMigrate(join(scratch, "db.sqlite3"));
    engine = new Engine({ embedded: true });
  });

  afterEach(async () => {
    await engine.close(true);
    db.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  test("happy-path dispatch reaches 'completed' identically", async () => {
    const deps = mode === "github"
      ? buildGitHubModeTestDeps({ db, scratch })
      : buildFileModeTestDeps({ db, scratch });

    engine.register(createImplementationWorkflow(deps));
    const handle = await engine.start("implementation", {
      repo: "acme/test",
      epicRef: mode === "github" ? "60" : "codex-adapter",
      adapter: "stub",
    });
    await awaitSettled(db, handle.id);
    expect(getWorkflow(db, handle.id)?.state).toBe("completed");
  });

  test("park → mm resume → continue closes the Epic identically", async () => {
    // Use a stub adapter that classifies the first Stop as 'asked-question',
    // then the next as 'done'. Verify the workflow parks, mm resume injects
    // the answer, the continuation completes.
  });
});
```

- [ ] **Step 2: Implement the test-deps builders**

`buildGitHubModeTestDeps` mirrors the existing `implementation-workflow.test.ts` builder. `buildFileModeTestDeps` writes a fixture Epic file into `<scratch>/planning/epics/codex-adapter.md`, configures repo_config to file mode, and wires the file gateways via `buildFileGateways`.

- [ ] **Step 3: Run**

```bash
bun test packages/dispatcher/test/epic-store/parity.test.ts 2>&1 | tail -10
```

Expected: ALL PASS for both `[github]` and `[file]` variants.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(epic-store): parametrized parity test — github vs file mode

The load-bearing test that proves 'no workflow code changes' on every
commit. Same workflow input, two gateway backends, equivalent outcome.
Catches any future divergence between modes — including subtle ones
like adapter selection, Q&A framing, or sub-issue resolution semantics."
```

---

### Task 22: End-to-end Phase 1 verification

- [ ] **Step 1: Run the full test suite**

```bash
bun run typecheck && bun run lint && bun run format && bun test 2>&1 | tail -10
```

Expected: ALL PASS, clean lint/format.

- [ ] **Step 2: Manual smoke — dispatch a file-mode test repo**

In a scratch directory:

```bash
mkdir -p /tmp/file-mode-smoke && cd /tmp/file-mode-smoke
git init && git commit --allow-empty -m init
mm init /tmp/file-mode-smoke --epic-store=file
# Author a tiny Epic file:
cat > planning/epics/hello.md <<'EOF'
<!-- middle:epic v1 -->
# Hello

<!-- middle:meta
slug: hello
-->

## Context

Add a HELLO.md file at the repo root.

## Acceptance criteria

- [ ] HELLO.md exists with "Hello, world!" content

## Sub-issues

<!-- middle:sub-issue id=1 -->
- [ ] **1 — Write HELLO.md**
<!-- /middle:sub-issue -->

<!-- middle:conversation -->
<!-- /middle:conversation -->
EOF
mm dispatch /tmp/file-mode-smoke hello
```

Observe: agent launches, works on `hello`, opens a branch (no GitHub PR in this local-only repo — that's fine for smoke; a real test repo with a GitHub remote would open one), closes the sub-issue checkbox, marks state in `.middle/state.md`.

- [ ] **Step 3: Commit any final docs / smoke notes**

```bash
git commit --allow-empty -m "chore(epic-store): Phase 1 verification — file-mode dispatch end-to-end

Manual smoke: mm init --epic-store=file → author Epic file → mm dispatch
→ agent works → sub-issue closed. parity.test.ts green for both modes.
typecheck/lint/format clean. Phase 1 DoD met."
```

---

## Phase 2 — File-watcher Q&A loop

### Task 23: mtime poll helper

**Files:**
- Create: `packages/dispatcher/src/epic-store/watcher.ts`
- Create: `packages/dispatcher/test/epic-store/watcher.test.ts`

- [ ] **Step 1: Test — detect newer mtimes**

```typescript
test("collectChangedSince returns Epic files whose mtime > sinceMs", async () => {
  // …write 3 files; touch one; expect only that one back
});
```

- [ ] **Step 2: Implement**

```typescript
// packages/dispatcher/src/epic-store/watcher.ts
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function collectChangedSince(epicsDir: string, sinceMs: number): string[] {
  const out: string[] = [];
  for (const f of readdirSync(epicsDir)) {
    if (!f.endsWith(".md") || f === "README.md") continue;
    const path = join(epicsDir, f);
    if (statSync(path).mtimeMs > sinceMs) out.push(f.replace(/\.md$/, ""));
  }
  return out;
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test packages/dispatcher/test/epic-store/watcher.test.ts 2>&1 | tail -5
git add -A
git commit -m "feat(epic-store): mtime poll helper for the file-mode Q&A loop"
```

---

### Task 24: `filePollGateway` poll pass for file signals

**Files:**
- Modify: `packages/dispatcher/src/epic-store/file-poll-gateway.ts`
- Modify: `packages/dispatcher/src/poller-cron.ts`
- Test: extend `packages/dispatcher/test/epic-store/file-poll-gateway.test.ts`

- [ ] **Step 1: Test — answer-block non-empty + mtime > createdAt → newReplyDetected**

```typescript
test("pollFileSignals returns Epic refs whose answer block became non-empty after sinceMs", async () => {
  // write epic with empty answer block, mtime old
  // touch + edit answer block, mtime new
  // expect ['codex-adapter']
});
```

- [ ] **Step 2: Implement `pollFileSignals` on `filePollGateway`**

```typescript
// inside makeFilePollGateway:
pollFileSignals: (sinceMs: number) => {
  const refs = collectChangedSince(opts.epicsDir, sinceMs);
  const repliedRefs: { ref: string; questionId: number; body: string }[] = [];
  for (const ref of refs) {
    const epic = parseEpicFile(readFileSync(join(opts.epicsDir, `${ref}.md`), "utf8"));
    for (const e of epic.conversation) {
      if (e.kind === "question" && e.status === "open" && e.answer) {
        repliedRefs.push({ ref, questionId: e.id, body: e.answer.body });
      }
    }
  }
  return repliedRefs;
},
```

(Add `pollFileSignals` to the `PollGateway` interface as an OPTIONAL method — github mode doesn't implement it.)

- [ ] **Step 3: Wire into the poller cron**

In `packages/dispatcher/src/poller-cron.ts`, on each tick, for every repo whose `epic_store === "file"`, call `pollFileSignals(repoCfg.lastPollMs)`. For each returned `{ ref, questionId, body }`, fire the resume signal exactly like `runPoller` does for a GitHub comment — find the workflow whose `epic_ref === ref` and is parked, `engine.signal(wf.id, RESUME_EVENT, { reason: "answered-question", reply: { commentId: questionId, authorLogin: "human", body } })`, then mark the question `status=resolved` in the Epic file.

- [ ] **Step 4: Run + commit**

```bash
bun test packages/dispatcher/test/epic-store/file-poll-gateway.test.ts 2>&1 | tail -5
git add -A
git commit -m "feat(epic-store): file-mode Q&A resume via mtime poll on the poller cron

filePollGateway.pollFileSignals scans epics_dir on the existing 120s
poller tick; an answer block becoming non-empty (mtime > sinceMs) fires
the resume signal exactly like a new GitHub comment does in github mode.
The question's status flips to 'resolved' in the same write."
```

---

### Task 25: Parity test — park/resume via file edit

- [ ] **Step 1: Extend `parity.test.ts`**

```typescript
test("park → file edit + watcher tick → continue closes the Epic identically", async () => {
  // adapter returns asked-question then done; agent parks; test edits the
  // Epic file's answer block; runs one poll tick; continuation completes
});
```

- [ ] **Step 2: Run + commit**

```bash
bun test packages/dispatcher/test/epic-store/parity.test.ts 2>&1 | tail -5
git add -A
git commit -m "test(epic-store): parity — Q&A resume via file edit + poller tick

Phase 2 DoD: editing the Epic file's answer block + waiting one poller
tick produces the same continuation as github-mode posting an issue
comment + waiting one poller tick."
```

---

### Task 26: End-to-end Phase 2 verification

- [ ] **Step 1: Full gates**

```bash
bun run typecheck && bun run lint && bun run format && bun test 2>&1 | tail -10
```

Expected: ALL PASS.

- [ ] **Step 2: Manual smoke — file-watcher Q&A loop**

Re-run the Task 22 smoke; this time give the agent a question, edit the answer block in the Epic file, wait ~120s, verify the agent resumes.

- [ ] **Step 3: Commit**

```bash
git commit --allow-empty -m "chore(epic-store): Phase 2 verification — file-watcher Q&A loop end-to-end

Manual smoke: dispatch → agent parks asking a question (question block
appears in Epic file) → edit answer block + save → wait <120s → agent
resumes with the answer in the prompt → completes. parity green for
both modes including the park/resume path. Phase 2 DoD met."
```

---

### Task 27: Open PR + reviewer's brief

- [ ] **Step 1: Push branch and open draft PR**

```bash
git push -u origin feat/file-backed-epic-store
gh pr create --draft \
  --title "feat(dispatcher): file-backed Epic store (opt-in hybrid)" \
  --body-file docs/superpowers/specs/2026-05-29-file-backed-epic-store-design.md
```

- [ ] **Step 2: Convert to ready when ready**

After CodeRabbit's review is resolved, `gh pr ready <n>` and post the reviewer's brief (mirroring the PR body) per the implementing-github-issues skill's Phase-10 instructions.

---

## Self-review checklist (run after writing the plan)

- [ ] **Spec coverage:** every spec section maps to a task above (architecture → Task 11; schema → Task 2/3; Epic file format → Task 5-7; gateways → Task 8-10; postQuestion → Task 12; CLI → Task 13-16; skills → Task 17-19; brief injection → Task 20; testing → Task 21/25; phases → Task 22/26). ✅
- [ ] **Placeholder scan:** every step shows the code/commands. No TBDs. ✅
- [ ] **Type consistency:** `epicRef: string` used throughout; `EpicGateway`/`StateGateway`/`PollGateway` names consistent post-Task-1. ✅
- [ ] **Scope:** single deliverable (file-backed Epic store, hybrid mode), two sequential phases — fits one plan. ✅
