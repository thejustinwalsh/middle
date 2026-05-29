# File-Backed Epic Store — Design

**Status:** Approved (brainstormed 2026-05-29)
**Author:** Justin Walsh (with Claude)
**Scope:** Add an opt-in, per-repo file-backed Epic store as a peer to today's GitHub-backed mode. PRs and CI stay on GitHub in both modes ("hybrid").

## Context

Today, middle treats GitHub as the only Epic substrate: Epics are issues, sub-issues are sub-issues, the recommender's queue is a single `<!-- AGENT-QUEUE-STATE v1 -->` issue, and the agent's questions/answers flow through issue comments. That works, but it couples the workflow to GitHub for the *plan and conversation* parts even when the user already has a local, file-based plan.

This design adds a **per-repo `epic_store = "file"` mode**: one Markdown file per Epic under `planning/epics/`, with the recommender's state in `.middle/state.md`. **PRs, reviews, and CI stay on GitHub** in both modes — only the Epic *data* and the agent-↔-human Q&A channel move to files. Both modes coexist: a daemon managing multiple repos can run each repo in whichever mode it's configured for.

The intended outcome: a user with a file-based plan can author Epic files locally and dispatch them through middle's existing workflow machinery, without GitHub serving any Epic-data role.

## Goals and non-goals

**Goals**

- One file per Epic; file is the canonical Epic data + conversation log.
- Per-repo opt-in via config; existing GitHub-mode repos unchanged.
- Workflow bodies, gates, watchdog, hook server, poller — **all unchanged**.
- The agent's existing `blocked.json` flow plugs in unchanged at one DI seam.
- Byte-identical round-trip for the Epic file under dispatcher writes.
- The parity-test guarantee: the same workflow input produces equivalent outcomes through both gateway backends.

**Non-goals**

- PRs file-backed. PRs, reviews, and CI status remain GitHub-native in both modes.
- A migration path from GitHub-mode to file-mode for existing repos. YAGNI; if ever needed, a `mm migrate-to-file` follow-up.
- Real-time file watching with `chokidar` or `fs.watch`. Phase 2 uses mtime polling on the existing 120s poller cron — symmetric latency with GitHub-mode comment polling, no extra dependency.
- A new "review" model. Real GitHub PRs handle review entirely.

## Architecture

The whole design is built on a single insight: middle already has three GitHub-coupled interfaces, all dependency-injected, all single chokepoints (`GitHubGateway`, `StateIssueGateway`, `GitHubPollGateway` — see `packages/dispatcher/src/github.ts`, `state-issue.ts`, `poller-gateway.ts`). We add **parallel file implementations behind the same interfaces** and **select per-repo at the dispatcher's bootstrap**.

```
                    ┌──────────────────────────────────────────────┐
                    │  packages/dispatcher (workflows / recommender│
                    │  / poller / gates — UNCHANGED bodies)        │
                    └────────┬───────────────┬───────────────┬─────┘
                             │               │               │
                             ▼               ▼               ▼
                    ┌────────────────┐ ┌──────────────┐ ┌──────────────────┐
                    │ EpicGateway    │ │ StateGateway │ │ PollGateway      │
                    │ (renamed,      │ │ (renamed,    │ │ (renamed,        │
                    │  body unchanged│ │  body unch.) │ │  body unch.)     │
                    └───────┬────────┘ └──────┬───────┘ └────────┬─────────┘
                            │                 │                  │
              ┌─────────────┼─────────────────┼──────────────────┼────────┐
              │             ▼                 ▼                  ▼        │
              │   ┌─────────────────┐ ┌────────────────┐ ┌───────────────┐│
   github     │   │  ghEpicGateway  │ │ghStateGateway  │ │ghPollGateway  ││
   mode       │   │  (today)        │ │ (today)        │ │ (today)       ││
              │   └─────────────────┘ └────────────────┘ └───────────────┘│
              │             ▼                 ▼                  ▼        │
              │   ┌─────────────────┐ ┌────────────────┐ ┌───────────────┐│
   file       │   │ fileEpicGateway │ │fileStateGateway│ │filePollGateway││
   mode       │   │  (NEW)          │ │ (NEW)          │ │ (NEW)         ││
              │   └─────────────────┘ └────────────────┘ └───────────────┘│
              └─────────────────────────────────────────────────────────────┘
                            ▲
                            │  selected per-repo at bootstrap from
                            │  repo_config.epic_store ∈ {"github" | "file"}
```

**Three load-bearing properties of this shape:**

1. The dispatcher daemon runs both modes simultaneously — repo A (`github`) and repo B (`file`) just pick different gateway implementations.
2. The existing interfaces are renamed for clarity (`GitHubGateway` → `EpicGateway`, etc.) but their **method signatures are unchanged**. Implementations differ; consumers don't.
3. The "Epic = numeric issue ID" assumption is the only thing that bleeds through today; it becomes `epicRef: string` (a slug in file mode, the stringified issue number in github mode for back-compat). Additive, back-compat schema migration.

**What stays untouched:** every workflow body (`implementation.ts`, `recommender.ts`, `documentation.ts`), every gate (`pr-ready`, `checkbox-revert`, `plan-comment`, `verify-on-stop`), the engine + durable recovery (#116), the watchdog (`watchdog.ts`), the session gate, the hook server, the dashboard's DB feed. Change is contained to **interfaces + file implementations + bootstrap wiring + schema migration**.

## Config schema

Mode is per-repo, in the existing `repo_config` table. Migration adds three columns (additive, with a back-compat default):

```sql
ALTER TABLE repo_config ADD COLUMN epic_store TEXT NOT NULL DEFAULT 'github';
ALTER TABLE repo_config ADD COLUMN epics_dir  TEXT;     -- file mode only; NULL for github
ALTER TABLE repo_config ADD COLUMN state_file TEXT;     -- file mode only; NULL for github
-- existing state_issue_number stays; populated in github mode, NULL in file mode
```

User-facing TOML (surfaced by `mm init` / `mm config`):

```toml
# .middle/<repo-slug>.toml
[epic_store]
mode        = "file"
epics_dir   = "planning/epics"   # default if mode=file
state_file  = ".middle/state.md" # default if mode=file
```

Omit the block entirely → github mode, defaults match today. **All existing repos work unchanged**; migration sets `epic_store = 'github'` for every existing row.

A second schema migration on the `workflows` table:

```sql
-- Make epic_number nullable; add string ref. Both populated in github mode
-- (number + stringified ref); only ref populated in file mode.
ALTER TABLE workflows ADD COLUMN epic_ref TEXT;
-- One-time backfill: epic_ref = CAST(epic_number AS TEXT) for existing rows.
UPDATE workflows SET epic_ref = CAST(epic_number AS TEXT) WHERE epic_ref IS NULL;
-- Then enforce NOT NULL on epic_ref (via table rebuild — SQLite quirk).
```

The dashboard's DB queries get updated at the same time (~5 sites; mechanical change verified by the existing dashboard test suite).

## Bootstrap selection

`build-deps.ts` is the single place that wires the three gateways. The change is one switch:

```ts
export async function buildImplementationDeps(args: BuildImplementationDepsArgs) {
  const repoCfg = readRepoConfig(args.db, args.repo);
  const { epicGateway, stateGateway, pollGateway } =
    repoCfg.epic_store === "file"
      ? buildFileGateways(args.db, repoCfg)
      : buildGitHubGateways(args.db, repoCfg);   // today's wiring, lifted into a helper
  return {
    /* …existing deps unchanged… */
    github: epicGateway,
    stateIssue: stateGateway,
    poller: pollGateway,
  };
}
```

`buildGitHubGateways` is today's existing wiring, extracted into a named helper. `buildFileGateways` is new (factory at `epic-store/index.ts`). Both return the same three-interface shape, so every downstream consumer is unchanged.

## `mm` commands per mode

| Command | github mode (today) | file mode |
|---|---|---|
| `mm init <repo>` | Creates state issue + label on GitHub | Scaffolds `planning/epics/` + writes empty `.middle/state.md`; no GitHub call |
| `mm doctor` | Checks `gh auth`, state issue exists | Skips state-issue check; still requires `gh` (PRs go there); checks `epics_dir` exists |
| `mm dispatch <repo> <epic>` | `<epic>` is an issue number | `<epic>` is a slug (filename without `.md`); back-compat: numeric also accepted |
| `mm dispatch --epic <slug>` | New flag, works in both modes | New flag, works in both modes |
| `mm resume <epic> --answer "…"` | NEW, both modes — manually fires resume signal for a parked Epic | Same — Phase 1 escape hatch before the watcher lands |

### What `mm init` writes for a file-mode repo

```
<repo>/
├─ .middle/
│  ├─ <repo-slug>.toml         # epic_store = "file" + paths
│  └─ state.md                 # empty state file with markers
└─ planning/
   └─ epics/
      ├─ README.md             # one-screen explainer + template snippet
      └─ .keep                 # for git
```

Zero GitHub calls during file-mode `mm init`.

## The Epic file format

`planning/epics/<slug>.md` — slug is the file's stem and the canonical Epic reference.

### Worked example: an authored Epic file (pre-dispatch)

```markdown
<!-- middle:epic v1 -->
# CodexAdapter

<!-- middle:meta
slug: codex-adapter
adapter: claude
complexity_ceiling: 3
approved: false
labels: [phase:10, dogfood]
-->

## Context

Phase 10 of the build spec. Implement a second AgentAdapter (Codex CLI) and
prove the abstraction holds across both adapters.

## Acceptance criteria

- [ ] Codex agent dispatches end-to-end against a test issue
- [ ] Per-CLI adapter selection respects label + default + rate-limit rules
- [ ] A test exercises both adapters through the same workflow path

## Sub-issues

<!-- middle:sub-issue id=1 -->
- [ ] **1 — Implement the CodexAdapter**
  Full AgentAdapter: launch command, installHooks (.codex/config.toml),
  rollout-transcript reads, sentinel + rate-limit stop classification.
  *Acceptance:* tests cover buildLaunchCommand, installHooks (TOML round-trip),
  classifyStop branches, transcript reads.
<!-- /middle:sub-issue -->

<!-- middle:sub-issue id=2 -->
- [ ] **2 — Per-CLI adapter selection (implementer + recommender)**
  selectAdapter rules: label override → default → rate-limit switch → skip.
  *Blocked by:* 1
<!-- /middle:sub-issue -->

<!-- middle:sub-issue id=3 -->
- [ ] **3 — Verify the abstraction holds across both adapters**
  Cross-adapter conformance test driving both through one workflow path.
  *Blocked by:* 1, 2
<!-- /middle:sub-issue -->

<!-- middle:conversation -->
<!-- /middle:conversation -->
```

### Worked example: mid-dispatch, agent parked asking a question

```markdown
<!-- middle:conversation -->

<!-- middle:dispatch-event ts=2026-05-29T04:28:40Z kind=dispatched -->
Dispatched workflow `wf_…oyy4c4m1` on branch `middle-epic-codex-adapter`,
draft PR #155.
<!-- /middle:dispatch-event -->

<!-- middle:question id=1 status=open ts=2026-05-29T04:53:30Z kind=question -->
> Should I defer the live dual-dispatch criterion (criterion 2) to a post-merge
> operator step, or run it now via [test repo]?

The dual-dispatch needs both `claude` and `codex` authenticated against a
mm-init'd test repo. Codex is now installed; recommending deferral so #155
can ship and #63 becomes a post-merge operator step.

<!-- middle:answer for=1 -->
<!-- Human edits here. File-watcher fires resume on this section becoming non-empty. -->
<!-- /middle:answer -->
<!-- /middle:question -->

<!-- /middle:conversation -->
```

### Worked example: sub-issue completed

```markdown
<!-- middle:sub-issue id=1 -->
- [x] **1 — Implement the CodexAdapter** *(done in wf_…oyy4c4m1, sha abc1234)*
  Full AgentAdapter: …
<!-- /middle:sub-issue -->
```

The agent flips the checkbox + appends a one-line provenance suffix. The recommender's "open sub-issues" count scans for unchecked boxes.

### Grammar — strict where structural, lenient where prose

| Element | Strictness | Why |
|---|---|---|
| `<!-- middle:* -->` markers (open + close) | **Strict** — exact bytes | The marker IS the structural contract |
| `<!-- middle:meta … -->` body | **Strict** — YAML-lite, one key per line | Machine-read |
| Sub-issue checkbox `- [x]` / `- [ ]` | **Strict** — single space, exact brackets | Same parse as PR Status section |
| Sub-issue title and body | **Lenient** — anything | Human prose |
| Acceptance criteria checkboxes | **Strict** brackets, **lenient** prose | Mirror sub-issue rule |
| Conversation entry markers + attributes (`id`, `status`, `ts`, `kind`) | **Strict** | Machine-read metadata |
| Conversation entry bodies | **Lenient** | Prose |
| Headings (`## Context`, `## Sub-issues`, …) | **Strict** — spelling + order | Unambiguous parse |
| Anything outside any marker | **Preserved verbatim** on round-trip | Human can insert prose; we leave it alone |

The lesson from #180 baked in: **every strict field has a single writer — the renderer.** The agent and the human only write *between* markers, never inside the strict-marker metadata. That structural rule is what kills #180's class for the file path.

### Byte-identical round-trip invariant

```
renderEpicFile(parseEpicFile(body)) === body
```

— for any body produced by `renderEpicFile`. Hard invariant; enforced by a property test over fixtures (empty Epic, mid-question, resolved-question + open follow-up, all sub-issues complete). Mirrors the state-issue v1 contract exactly.

This invariant lets file mode work **safely concurrent** without locking: dispatcher patches conversation entries via the renderer; human edits between markers or inside their `<!-- middle:answer -->` block. Round-trip purity replaces a lock.

## The three new file gateways

### `fileEpicGateway` — implements `EpicGateway`

A **composite** gateway: Epic-shaped methods served from files; PR-shaped methods delegated to an internal `gh` backend.

| Method | File mode behavior |
|---|---|
| `listOpenEpics(repo)` | Scan `epics_dir`; parse `<!-- middle:meta -->` + sub-issue checkboxes; return `{ ref, title, openSubs, closedSubs, labels, adapter }[]`. Skip files marked `closed`. |
| `listIssueComments(repo, ref)` | Parse `<!-- middle:conversation -->` into `IssueComment[]`; `authorIsBot` derived from marker (`question` / `dispatch-event` → bot; `answer` → human) |
| `getCommentAuthor(url)` | Comment URL = `file://<path>#question-N` or `#answer-N`; resolves to `"agent"` or `"human"` |
| `getIssueLabels(repo, ref)` | Read `labels` from `<!-- middle:meta -->` |
| `postComment(repo, ref, body)` | Append a new `<!-- middle:dispatch-event -->` or `<!-- middle:question -->` block via renderer |
| `editComment(commentId, body)` | Patch the matching marker block in place via renderer (used by gates' evidence-comment upsert) |
| `findEpicPr(repo, ref)` | Read `pr:` from `<!-- middle:meta -->`; if set, delegate to gh for `getPullRequest`; else null |
| `getPullRequest(repo, prNumber)` | **Delegate to gh** |
| `editPullRequestBody(repo, prNumber, body)` | **Delegate to gh** |
| `resolveAgentLogin()` | **Delegate to gh** (`gh api user`) |

### `fileStateGateway` — implements `StateGateway`

Smaller surface:

| Method | File mode behavior |
|---|---|
| `readBody(repo)` | `readFileSync(state_file)` |
| `writeBody(repo, body)` | Atomic write to `state_file` (write-temp + rename) |

The `applyDispatcherSections` / `renderStateIssue` flow in `state-issue.ts` is unchanged — same parser, same renderer, same byte-identical-round-trip invariant. **Closes #180's class entirely for file mode**: there's no recommender-agent rewriting the In-flight section out-of-band; the dispatcher writes it directly via `renderStateIssue`.

### `filePollGateway` — implements `PollGateway`

| Method | File mode behavior |
|---|---|
| `listIssueComments(repo, ref)` | Same as `fileEpicGateway.listIssueComments` |
| `findPrForEpic(repo, ref)` | **Delegate to gh** (PR reviews/CI are still GitHub-native) |
| `findEpicPrLifecycle` | **Delegate to gh** |
| `statusCheckRollup` | **Delegate to gh** |
| `getRateLimit()` | **Delegate to gh** |

**File-watcher mechanics (Phase 2).** The poller already runs every `POLLER_INTERVAL_MS = 120_000` (per `packages/dispatcher/CLAUDE.md`). For file-mode repos, the poller pass also stats `epics_dir/*.md` and tests `mtime > wait.createdAt` before parsing for new `<!-- middle:answer -->` content. **Stat-based mtime polling on the existing cron** — no `chokidar`, no extra dependency, no missed-event semantics. Worst-case latency is symmetric with GitHub-mode comment polling (also 120s).

## How `blocked.json` plugs in (zero workflow change)

Today's flow:

```
agent writes .middle/blocked.json
       ↓
classifyStop → { kind: "asked-question", sentinel: {...} }
       ↓
parkForResume → deps.postQuestion({ repo, epicRef, question, context, kind })
                              ↑
                              this is DI'd
```

`deps.postQuestion` is **already a dependency seam** wired in `build-deps.ts` to a `gh`-backed comment poster. For file mode, `buildFileGateways` wires it to a file-backed writer:

```ts
const postQuestion: ImplementationDeps["postQuestion"] = async (opts) => {
  const epic = await readEpicFile(opts.repo, opts.epicRef);
  const nextId = epic.conversation.nextQuestionId();
  epic.conversation.append({
    kind: "question",
    id: nextId,
    status: "open",
    ts: new Date().toISOString(),
    body: opts.question + (opts.context ? `\n\n${opts.context}` : ""),
    questionKind: opts.kind, // "question" | "complexity"
  });
  await writeEpicFile(opts.repo, opts.epicRef, epic);
};
```

That's it. Every upstream concern — `classifyStop` → `asked-question`, `parkForResume` arming the resume signal, `awaitNextStop` racing session-end, the whole watchdog self-heal — **continues to work unmodified**. The agent's `blocked.json` is mode-agnostic; the only mode-aware step is the comment-write itself.

The poller's resume side is symmetric: existing `classifyNewHumanReply` filters `!authorIsBot && createdAt > sinceMs`. `filePollGateway.listIssueComments` returns conversation entries with `authorIsBot=false` only for `<!-- middle:answer -->` blocks (which by definition are human-written, marker says so). New answer with `mtime > sinceMs` fires the resume signal exactly like a new GitHub comment.

## PR ↔ Epic linkage

PR body carries `<!-- middle:epic <slug> -->`. `findEpicPr` matches that marker. The Epic file's `<!-- middle:meta -->` block also stores `pr: <number>` (stamped once when the PR opens) as a durable backup if the PR body marker is ever lost.

Zero collision risk with real GitHub issues (`#<N>` is not used as the reference in file mode).

## Cross-Epic blocked-by

Today the recommender shows "#124 blocked on #60" by reading sub-issue parent/child via GitHub. In file mode, the same relationship uses a slug reference:

```yaml
<!-- middle:meta
slug: copilot-adapter
blocked-by: [codex-adapter]
-->
```

The recommender's graph builder reads `blocked-by` slugs from each file's meta. Recommender skill update + small graph helper. In scope for Phase 1.

## Skills

Three skills need work. The pattern in each: abstract the *workflow body* (mode-agnostic — "fetch the Epic", "comment the plan on the Epic", "close the sub-issue with evidence"), and pull the per-mode incantations into a separate Commands section or `references/<mode>-mode-commands.md` file.

- **`implementing-github-issues`** — refactored: abstract body talks about "the Epic" mode-agnostically; per-mode Commands section at the end (or `references/file-mode-commands.md`). The dispatch-brief generator (`ensurePromptFile`) injects the right Commands snippet into the agent's `prompt.md` based on the run's mode.
- **`recommending-github-issues`** — same abstraction; file-mode commands scan `epics_dir` and write the state file via the renderer (not by hand — closes #180 for this skill too).
- **`creating-github-issues`** — gets a file-mode variant (or sibling `creating-file-epics` skill) for authoring an Epic file from a plan/spec.

Skills that stay the same: `documenting-the-repo`, all `superpowers:*` process skills, all orthogonal command skills (`verify`, `run`, `simplify`, `code-review`, `init`, `review`, `security-review`).

## Error handling

| Failure | File mode surface |
|---|---|
| Epic file missing on disk | `mm dispatch` exits non-zero with `Epic '<ref>' not found at <path>`; daemon refuses to start the workflow |
| Epic file parse error (malformed marker) | Workflow refuses to dispatch; one `<!-- middle:parse-error -->` block appended idempotently to the Epic file's conversation section so the operator sees the failure inline (no log-tailing needed) |
| Concurrent edit race | Write-temp + rename; re-stat source before rename; if mtime changed, re-read + re-merge + re-write (bounded 3 retries, then fail loudly) |
| Watcher misses an mtime tick | 120s polling cadence; worst-case 120s extra latency; symmetric with GitHub mode |
| Human deletes `<!-- middle:epic v1 -->` marker | Parser refuses to read; workflow won't dispatch; clear named-marker error |
| Human deletes PR-body `<!-- middle:epic <slug> -->` marker | `findEpicPr` falls back to `pr:` field in Epic file's `<!-- middle:meta -->` (stamped once at PR creation) |
| File permissions / disk full | Standard fs error propagation; surfaces as a step failure with the OS error |

General rule: file-mode failures are **diagnosable from the Epic file itself**. Operators never need to read daemon logs to learn what went wrong.

## Testing strategy

Three layers.

**Layer 1 — Unit tests for the new code.** Each new file gateway, the parser, the renderer, the round-trip property test. Pure-function tests, no daemon, no engine. Mirrors how `packages/state-issue/test/` is shaped today. ~400 lines of new test code.

**Layer 2 — The parametrized parity test.** The load-bearing test: a single fixture runs the implementation workflow end-to-end with each gateway backend and asserts **the same workflow outcome** for the same input:

```ts
// packages/dispatcher/test/epic-store/parity.test.ts
describe.each(["github", "file"])("workflow parity — %s mode", (mode) => {
  test("dispatch → park → resume → continue closes the Epic identically", async () => {
    const deps = mode === "github"
      ? buildTestDepsWithGitHubGateways(/* stubbed gh */)
      : buildTestDepsWithFileGateways(/* tmpdir + epic file */);
    const id = await dispatch(deps, EPIC_REF);
    await awaitParked(id);
    await answerQuestion(deps, EPIC_REF, "approved");
    await awaitContinuation(id);
    await awaitSettled(id);
    expect(getWorkflow(db, id)?.state).toBe("completed");
  });
});
```

If the workflow ever takes a different path in the two modes for the same input, this catches it. Proves "no workflow code changes" on every commit.

**Layer 3 — The existing test suite, unchanged.** Every workflow, gate, watchdog, hook-server, poller test keeps passing because the workflow bodies don't change. Schema migration tests added; everything else untouched.

## Files

```
packages/dispatcher/src/
├─ github.ts                          # rename: GitHubGateway → EpicGateway
├─ state-issue.ts                     # rename: StateIssueGateway → StateGateway
├─ poller-gateway.ts                  # rename: GitHubPollGateway → PollGateway
├─ build-deps.ts                      # add buildGitHubGateways / buildFileGateways switch
└─ epic-store/                        # NEW
   ├─ index.ts                        # buildFileGateways(db, repoCfg)
   ├─ epic-file/
   │  ├─ parser.ts                    # parse → typed model
   │  ├─ renderer.ts                  # types → file (round-trip)
   │  ├─ types.ts                     # EpicFile, SubIssue, Question, Answer
   │  └─ markers.ts                   # all `<!-- middle:* -->` constants
   ├─ file-epic-gateway.ts            # implements EpicGateway from files
   ├─ file-state-gateway.ts           # implements StateGateway from a file
   ├─ file-poll-gateway.ts            # implements PollGateway from files (+ Phase 2 mtime poll)
   └─ watcher.ts                      # mtime poll helper
packages/dispatcher/test/epic-store/
   ├─ parser.test.ts                  # round-trip + edge cases
   ├─ file-epic-gateway.test.ts       # composite delegation behavior
   ├─ file-state-gateway.test.ts
   ├─ file-poll-gateway.test.ts
   └─ parity.test.ts                  # parametrized github | file
packages/cli/src/
├─ commands/init.ts                   # file-mode scaffold branch
├─ commands/dispatch.ts               # --epic <slug> flag, slug-or-number arg
├─ commands/doctor.ts                 # mode-aware checks
└─ commands/resume.ts                 # NEW: mm resume <epic> --answer "…"
packages/skills/
├─ implementing-github-issues/SKILL.md          # abstract body
├─ implementing-github-issues/references/
│  ├─ github-mode-commands.md                   # NEW
│  └─ file-mode-commands.md                     # NEW
├─ recommending-github-issues/SKILL.md          # abstract body
└─ recommending-github-issues/references/       # per-mode commands
```

Estimated ~1,200 LOC of new code + ~600 LOC of tests + skill refactor.

## Phase plan

### Phase 1 — File-Epic dispatch (no watcher yet) — ~2 weeks

- Schema migrations (`epic_store`, `epics_dir`, `state_file` on `repo_config`; `epic_ref` on `workflows`; dashboard query updates)
- Parser + renderer + round-trip property test
- `fileEpicGateway`, `fileStateGateway`, `filePollGateway` (composite + delegating)
- `buildFileGateways` factory + bootstrap selector in `build-deps.ts`
- `mm init` file-mode scaffold
- `mm dispatch --epic <slug>` (and back-compat slug-or-number)
- `mm doctor` mode-aware checks
- **`mm resume <epic> --answer "…"`** — manual escape hatch for parked workflows
- Skill refactor (`implementing-github-issues`, `recommending-github-issues`, `creating-github-issues`) + dispatch-brief generator update
- Parity test passing for happy path + manual `mm resume`-driven park/resume

**Value at end of Phase 1:** Author Epic files, dispatch with `mm dispatch`, agent works, opens real GitHub PR, marks ready, you merge. Parked workflows resume via `mm resume`. **Complete, usable feature** without the watcher.

### Phase 2 — File-watcher Q&A loop — ~1 week

- `filePollGateway.pollFileSignals` added to existing poller cron (120s tick)
- Detection: `<!-- middle:answer for=N -->` non-empty + mtime > wait's `createdAt`
- Workflow resumes automatically on next 120s tick after edit + save
- `mm resume` from Phase 1 stays as a manual escape hatch
- Parity test passing with "edit the file + wait" replacing `mm resume`

**Value at end of Phase 2:** Q&A loop is fully native. Edit Epic file, save, wait <120s, agent resumes.

### Definition of Done

- **Phase 1:** parity test green; full existing test suite still green (`bun test`); typecheck/lint/format clean; `mm init` + `mm dispatch` + `mm resume` work end-to-end on a file-mode test repo; one Epic dispatched manually through both modes producing equivalent PRs.
- **Phase 2:** parity test passes with `answerQuestion` swapped to edit-file-and-wait; manual `mm resume` still works.

## Open risks (in-scope mitigations)

1. **Cross-Epic blocked-by linking.** New `blocked-by:` meta key + recommender graph builder. Half a day; in scope for Phase 1.
2. **`epic_number` → `epic_ref` migration touches dashboard.** ~5 query sites, mechanical; verified by existing dashboard test suite.
3. **PR body marker robustness.** If a human deletes `<!-- middle:epic <slug> -->`, `findEpicPr` falls back to the durable `pr:` field in Epic file `<!-- middle:meta -->`. Both written; either alone is sufficient.

## Out of scope (explicitly)

- GitHub → file mode migration (`mm migrate-to-file`)
- Real-time `chokidar` watching
- File-backed PRs / reviews / CI
- Cross-repo Epic references (`other-repo/codex-adapter`)
- An "abstract `EpicStore` interface above the existing gateways" refactor (Approach B from brainstorm) — only worth the effort if a third backend ever appears

## References

- Brainstorm transcript: this session (2026-05-29), starting at "I want to be able to run middle in a repo from a file"
- Surface map: Explore agent sweep, complete list of GitHub touchpoints (12 read + 7 write operations, 3 single-seam interfaces)
- Existing convention precedent: `<!-- AGENT-QUEUE-STATE v1 -->` marker in `packages/state-issue/src/constants.ts:4`; `<!-- middle:gate-evidence:phase-N -->` in `planning/issues/37/decisions.md:39`
- Coupled bugs whose fixes this design absorbs: #178 (channel-mismatch — file mode's structurally-distinct `question`/`answer` markers make it impossible); #180 (state-issue parse failure — file mode's "renderer is the only writer" rule makes it impossible)
- Schema source of truth: `schemas/state-issue.v1.md` (same parser conventions extended to Epic files)
