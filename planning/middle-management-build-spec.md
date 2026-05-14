# middle-management — Build Spec

A local orchestration layer for agentic coding work. It dispatches Claude Code and Codex agents against GitHub issues, enforces a strict implementation workflow via skills the agents run, monitors agent health via hooks, and surfaces only what truly needs human attention. GitHub is the system of record; middle is the operator.

This document is the build spec. It's designed to be handed to an agent (or a developer) and built in a single workstream, **dogfooding from the first commit** — the repo building middle uses middle to dispatch its own remaining work.

---

## Glossary

- **middle** — the system. The CLI binary is `mm`. In prose, "middle" is fine.
- **dispatcher** — the long-running middle process. Houses the bunqueue engine, hook receiver, watchdog, recommender scheduler, and HTTP dashboard.
- **adapter** — implementation of a CLI agent: `claude`, `codex`, etc. Behind one interface (`AgentAdapter`).
- **workflow** — a bunqueue workflow execution. Two kinds: `implementation` (per issue) and `recommender` (per repo, cron).
- **state issue** — one GitHub issue per repo, label `agent-queue:state`, whose body is the recommender's ranked output and the dashboard's primary read source.
- **worktree** — a git worktree under `~/.middle/worktrees/<repo>/issue-<n>/` (or `recommender/`), one per active workflow.
- **bootstrap / unbootstrap** — `mm init <repo>` installs middle's skills, hooks, and the state issue into a target repo. `mm uninit <repo>` removes them. Safe and reversible.

---

## Non-goals (stated up front)

1. **Not a multi-tenant SaaS.** Local only. One user. The user is logged into each CLI subscription themselves.
2. **No cross-repo intelligence.** One recommender per repo. Humans coordinate batches across repos.
3. **Not a chat UI for agents.** Agents run headlessly in tmux. The dashboard is read-only on agent state.
4. **Not a code reviewer.** Mechanical verification gates only. Humans review and merge PRs.
5. **No private storage of work data.** GitHub is the source of truth for issues, plans, decisions, evidence. middle's SQLite holds operational state only — agent heartbeats, workflow executions, rate-limit reactions. Wiping middle's SQLite must not lose anything important.
6. **No undocumented APIs for rate limits.** GitHub's `rate_limit` endpoint is fair game. For CLI subscriptions: reactive detection only (catch the error, extract the reset, wait).

---

## Top-level architecture

```
                    ┌─────────────────────────────────────────────┐
                    │           middle dispatcher (single proc)    │
                    │                                              │
   GitHub ◄────────►│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
                    │  │ bunqueue │  │   hook   │  │ watchdog │  │
                    │  │  engine  │  │ receiver │  │  ticker  │  │
                    │  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
                    │       │             │             │         │
                    │       ▼             ▼             ▼         │
                    │   ┌─────────────────────────────────────┐   │
                    │   │            SQLite (WAL)              │   │
                    │   └─────────────────────────────────────┘   │
                    │       │                                      │
                    │       ▼                                      │
                    │   ┌───────────┐    ┌──────────────┐         │
                    │   │  Bun.serve│◄──►│  Dashboard   │         │
                    │   │  HTTP+SSE │    │   (React)    │         │
                    │   └───────────┘    └──────────────┘         │
                    └──────────┬───────────────────────┬──────────┘
                               │                       │
                    ┌──────────▼──────────┐  ┌─────────▼──────────┐
                    │   tmux sessions     │  │   git worktrees    │
                    │   running agents    │  │  ~/.middle/worktrees│
                    │   (Claude / Codex)  │  │                    │
                    └─────────────────────┘  └────────────────────┘
```

Single dispatcher process. tmux is the agent supervisor. Worktrees isolate concurrent work. The dashboard is HTTP served on `localhost:8822`; an optional webview wrapper can be added later.

---

## Repo layout

middle is a TypeScript monorepo built with Bun.

```
middle/
├── README.md
├── package.json                    # workspace root
├── bun.lockb
├── tsconfig.json
├── packages/
│   ├── core/                       # types, schemas, adapter interface
│   │   ├── src/
│   │   │   ├── types.ts
│   │   │   ├── adapter.ts          # AgentAdapter interface
│   │   │   ├── events.ts           # NormalizedEvent shape
│   │   │   └── config.ts           # config.toml shape + loader
│   │   └── package.json
│   ├── state-issue/                # schema, parser, renderer
│   │   ├── src/
│   │   │   ├── schema.v1.ts        # types matching state-issue.v1.md
│   │   │   ├── parser.ts
│   │   │   ├── renderer.ts
│   │   │   └── validate.ts
│   │   ├── test/                   # round-trip fixtures
│   │   └── package.json
│   ├── adapters/
│   │   ├── claude/
│   │   │   ├── src/
│   │   │   │   ├── index.ts        # implements AgentAdapter
│   │   │   │   ├── hooks.ts        # writes .claude/settings.json
│   │   │   │   ├── classify.ts     # exit/error classifier
│   │   │   │   └── prompt.ts       # builds the CLI prompt
│   │   │   └── package.json
│   │   └── codex/
│   │       └── (same shape)
│   ├── dispatcher/                 # the long-running process
│   │   ├── src/
│   │   │   ├── main.ts             # entrypoint
│   │   │   ├── db.ts               # SQLite + migrations
│   │   │   ├── workflows/
│   │   │   │   ├── implementation.ts
│   │   │   │   ├── recommender.ts
│   │   │   │   └── steps/          # individual reusable steps
│   │   │   ├── hook-server.ts      # HTTP receiver for agent hooks
│   │   │   ├── watchdog.ts         # heartbeat / liveness reconciler
│   │   │   ├── rate-limits.ts      # reactive detection + state
│   │   │   ├── slots.ts            # concurrency gating
│   │   │   ├── github.ts           # gh CLI wrapper
│   │   │   ├── worktree.ts         # worktree create/destroy
│   │   │   ├── tmux.ts             # spawn/attach/status helpers
│   │   │   └── auto-dispatch.ts    # the loop that picks ranked work
│   │   └── package.json
│   ├── dashboard/                  # React SPA + Bun.serve handlers
│   │   ├── src/
│   │   │   ├── server.ts           # serves index.html + SSE + API
│   │   │   ├── routes/             # JSON API for the SPA
│   │   │   └── app/                # React app source
│   │   └── package.json
│   ├── cli/                        # the `mm` binary
│   │   ├── src/
│   │   │   ├── index.ts            # commander wiring
│   │   │   ├── commands/
│   │   │   │   ├── init.ts         # bootstrap a repo
│   │   │   │   ├── uninit.ts       # remove from repo
│   │   │   │   ├── start.ts        # start dispatcher
│   │   │   │   ├── stop.ts
│   │   │   │   ├── status.ts       # quick repl summary
│   │   │   │   ├── run.ts          # run recommender or implementer now
│   │   │   │   ├── pause.ts        # pause auto-dispatch per repo
│   │   │   │   ├── slots.ts        # set concurrency
│   │   │   │   ├── doctor.ts       # health check
│   │   │   │   └── attach.ts       # prints `tmux attach -t ...` for an issue
│   │   │   └── bootstrap-assets/   # files copied into the target repo
│   │   │       ├── skills/
│   │   │       │   ├── implementing-github-issues/SKILL.md
│   │   │       │   ├── implementing-github-issues/references/vitexec-integration-suite.md
│   │   │       │   └── recommending-github-issues/SKILL.md
│   │   │       ├── hooks/
│   │   │       │   └── hook.sh                # the universal POST script
│   │   │       └── middle-config.toml.template
│   │   └── package.json
│   └── skills/                     # canonical skill text, kept in sync with bootstrap-assets/
│       ├── implementing-github-issues/
│       │   ├── SKILL.md
│       │   └── references/
│       │       └── vitexec-integration-suite.md
│       └── recommending-github-issues/
│           └── SKILL.md
├── schemas/
│   └── state-issue.v1.md            # the schema doc, read by parser + recommender
├── docs/
│   ├── architecture.md
│   ├── adapters.md
│   ├── bootstrap.md
│   ├── skill-enforcement.md
│   ├── dogfooding.md
│   └── operator.md                  # how to use the CLI / dashboard
├── scripts/
│   ├── dev.sh                       # start dispatcher in dev mode
│   └── reset-db.sh                  # nuke SQLite (does not touch GitHub)
└── .middle/                         # middle's OWN bootstrap into itself (dogfooding)
    ├── config.toml
    ├── skills/                      # symlinks to ../packages/skills/*
    └── hooks/
        └── hook.sh
```

**Two copies of skill text** — `packages/skills/` is the canonical source; `packages/cli/src/bootstrap-assets/skills/` is what gets stamped into a target repo by `mm init`. A pre-commit hook (added later) keeps them in sync; `mm doctor` flags drift.

---

## Tech stack

- **Runtime**: Bun (latest stable; ≥1.3.12 for `Bun.WebView` optional, but the dashboard is HTTP-only by default).
- **Language**: TypeScript across the board.
- **Workflow engine**: `bunqueue` + `bunqueue/workflow`.
- **DB**: Bun's built-in SQLite (`bun:sqlite`) in WAL mode. One file: `~/.middle/db.sqlite3`.
- **HTTP**: `Bun.serve()`.
- **SSE**: Bun's native streaming Response support.
- **CLI framework**: `commander` (small, well-known, fine).
- **TOML**: `smol-toml` (lightweight, no node-gyp).
- **React**: 19, bundled by Bun's built-in bundler. No webpack/vite — Bun's `serve` with HTML imports.
- **Process supervision**: tmux (`tmux new-session -d`). Agents run inside.
- **GitHub access**: shell-out to `gh`. The user is already authenticated.
- **Webview (optional)**: `webview-bun` for a windowed mode, gated behind a flag. Default is HTTP.

No Redis. No Postgres. No external services.

---

## Configuration

Two scopes:

### Global config: `~/.middle/config.toml`

```toml
[global]
dispatcher_port = 8822
max_concurrent = 4
default_adapter = "claude"
log_dir = "~/.middle/logs"
worktree_root = "~/.middle/worktrees"
db_path = "~/.middle/db.sqlite3"

[adapters.claude]
enabled = true
binary = "claude"                         # or full path
permission_mode = "auto"                  # or "default", "acceptEdits", "plan"
extra_args = []

[adapters.codex]
enabled = true
binary = "codex"
sandbox = "workspace-write"
approval_policy = "never"
extra_args = []

[dashboard]
windowed = false                          # if true, also launch webview-bun window
theme = "auto"
```

### Per-repo config: `<repo>/.middle/config.toml` (created by `mm init`)

```toml
[repo]
owner = "tjwesley"
name = "middle"
default_branch = "main"

[limits]
max_concurrent = 3
max_concurrent_per_adapter = { claude = 2, codex = 1 }
complexity_ceiling = 4

[recommender]
enabled = true
interval_minutes = 15
adapter = "claude"                   # which CLI runs the recommender itself
auto_dispatch = false                     # SAFE DEFAULT — opt in per repo

[state_issue]
number = 0                                # filled in by `mm init` after issue creation
label = "agent-queue:state"

[bootstrap]
version = 1                               # schema version; `mm uninit` knows what to remove
installed_at = "2026-05-13T15:00:00Z"
```

The dispatcher reads both files at startup and merges. Per-repo overrides global.

---

## Bootstrap: `mm init <path-or-repo-spec>`

This is the most important command for the user-facing surface. It does the following, transactionally:

1. **Validate target**. Must be a clean git working tree, must have a GitHub remote, `gh` must be authenticated for it.
2. **Idempotency check**. If `.middle/config.toml` exists and `bootstrap.version` matches, this is a re-init — refresh skills/hooks but keep config. If version differs, run migration. If absent, fresh install.
3. **Stage files into target repo**:
   - Copy `bootstrap-assets/skills/implementing-github-issues/` to `<repo>/.claude/skills/implementing-github-issues/`
   - Copy `bootstrap-assets/skills/recommending-github-issues/` to `<repo>/.claude/skills/recommending-github-issues/`
   - For Codex parity: also write `<repo>/.codex/skills/` mirrors (Codex doesn't read `.claude/`).
   - Copy `bootstrap-assets/hooks/hook.sh` to `<repo>/.middle/hooks/hook.sh` (chmod +x)
   - Write `<repo>/.middle/config.toml` from the template, filled in
4. **Write per-CLI hook config** referencing the universal `hook.sh`:
   - `<repo>/.claude/settings.json` with hook entries (see "Hook installation" below)
   - `<repo>/.codex/config.toml` `[hooks]` section
5. **Create the state issue on GitHub** with `gh issue create --label agent-queue:state --title "agent-queue: dispatch state" --body "<initial empty schema-conforming body>"`. Capture the issue number; write it into `<repo>/.middle/config.toml`.
6. **Create the label** if it doesn't exist: `gh label create agent-queue:state --color 6f42c1 --description "Maintained by middle-management"`.
7. **Update target repo's `.gitignore`**: add `.middle/` (so the per-repo middle dir is ignored). Skills under `.claude/skills/` SHOULD be committed (they're shared with collaborators); the bootstrap status under `.middle/` is local-only.
8. **Print a summary**:
   ```
   ✓ middle initialized for tjwesley/middle
     skills installed at .claude/skills/, .codex/skills/
     hook script at .middle/hooks/hook.sh
     state issue created: #142
     config: .middle/config.toml
     auto-dispatch: OFF (enable with `mm config tjwesley/middle auto_dispatch true`)
   ```

`mm init` is reversible. `mm uninit <path>` does:

1. Close the state issue with a comment ("Removed via `mm uninit`").
2. Delete the `agent-queue:state` label (optional — prompt the user; preserving it is fine).
3. Remove all bootstrapped files: `.claude/skills/{implementing,recommending}-github-issues/`, `.codex/skills/...`, `.middle/`.
4. Remove the hook config blocks from `.claude/settings.json` and `.codex/config.toml` (leave other entries intact).
5. Remove `.middle/` from `.gitignore`.
6. Print a summary of what was removed.

Both commands have a `--dry-run` flag that prints the planned actions without executing.

---

## State issue schema

Lives at `schemas/state-issue.v1.md`. **This is a build artifact** — both the recommender (when writing) and the dispatcher/dashboard (when reading) conform to it. Keep this file in sync with code; `mm doctor` re-validates the parser against this doc.

```markdown
# Agent Queue State Issue — Schema v1

## Top-level structure

Body has exactly:
1. `<!-- AGENT-QUEUE-STATE v1 -->` marker (REQUIRED, exact)
2. Metadata HTML comment block (REQUIRED)
3. Seven named sections in fixed order (REQUIRED, each as `## <Name>`)
4. `<!-- /AGENT-QUEUE-STATE -->` closing marker (REQUIRED, exact)

Content outside the markers is ignored.

## Metadata

<!-- generated: <ISO 8601> · run: <8-char hex> · interval: <duration> -->
<!-- owners: recommender=..., dispatcher=... -->

## Sections (in order)

### 1. ## Ready to dispatch

Table with EXACTLY columns: | Rank | Issue | Adapter | Est. phases | Reason |
- Rank: int starting at 1, sequential
- Issue: `#<n> <title>` (title truncated to 60 chars with …)
- Adapter: configured adapter name
- Est. phases: int 1-99 or `?`
- Reason: ≤180 chars, single line, only backtick markdown
- Empty state: single row `| — | _no issues ready_ | — | — | — |`

### 2. ## Needs human input

Bulleted list. Each: `- **#<n> <short label>** — <one-liner> · [link]`
Short labels (stable vocabulary): fork tied, ambiguous criteria, ready for review,
size above ceiling, awaiting reply, blocking critical path

### 3. ## Blocked

Bulleted list. `- **#<n>** waiting on #<blocker> · <context>`
Non-issue blockers: `waiting on \`<description>\``

### 4. ## In-flight  [DISPATCHER-OWNED]

`- **#<n>** · <adapter> · <progress> · last heartbeat <rel> · [tmux: <session>]`
Progress: `phase <m>/<n>` or `running`
Empty: `- _no agents in flight_`

### 5. ## Excluded

`- **#<n>** <reason category> — <detail>`
Categories (closed set): size above ceiling, assigned to human, needs-design label,
acceptance criteria missing, archived, out of scope

### 6. ## Rate limits  [DISPATCHER-OWNED]

- claude: <AVAILABLE | RATE LIMITED until <ISO> (in <rel>) | UNKNOWN>
- codex: <same>
- github: <n/m req/hr · resets in <rel> | EXHAUSTED until <ISO>>

### 7. ## Slot usage  [DISPATCHER-OWNED]

- <adapter>: <used>/<max>
- (one per configured adapter)
- total: <repo-used>/<repo-max>
- global: <global-used>/<global-max>

## Validation rules

Body PASSES iff:
1. Both markers present
2. All 7 sections in order
3. Ready table has exact column header
4. All #N references match /#\d+/
5. Adapter names are configured
6. Empty sections use documented empty state
7. Metadata `generated` parses as ISO 8601

## Diff semantics

Dispatcher updates In-flight / Rate limits / Slot usage between recommender runs;
does NOT touch `generated`. May insert `<!-- dispatcher-tick: <ts> -->` markers
between sections (ignored by parsers).
Recommender rewrites the entire body on its scheduled run, replacing dispatcher's
eager updates with a fresh full snapshot.

## Parser interface (TypeScript)

```ts
type ParsedState = {
  version: 1;
  generated: string;
  runId: string;
  intervalMinutes: number;
  readyToDispatch: ReadyRow[];
  needsHumanInput: NeedsHumanItem[];
  blocked: BlockedItem[];
  inFlight: InFlightItem[];
  excluded: ExcludedItem[];
  rateLimits: RateLimits;
  slotUsage: SlotUsage;
};

function parseStateIssue(body: string): ParsedState | ParseError;
function renderStateIssue(state: ParsedState): string;
function validate(state: ParsedState, config: RepoConfig): ValidationResult;
```

Round-trip property: `renderStateIssue(parseStateIssue(body))` is byte-identical
for any valid body. This is what lets dispatcher edit one section without
disturbing others.
```

**Build the parser and renderer FIRST**, with a fuzz test that asserts round-trip equality. Everything downstream depends on this contract not breaking.

---

## Skills shipped with middle

Two skills installed into every bootstrapped repo:

### 1. `implementing-github-issues`

You already have this skill. middle ships your existing version verbatim from `packages/skills/implementing-github-issues/`. The build should treat this as canonical source — if you update the skill, update it here and the bootstrap copy is regenerated.

Path in target repo: `.claude/skills/implementing-github-issues/`
- `SKILL.md`
- `references/vitexec-integration-suite.md`

For Codex parity: same content mirrored to `.codex/skills/implementing-github-issues/`.

### 2. `recommending-github-issues`

New, ships in this build. Full text below. Save to `packages/skills/recommending-github-issues/SKILL.md`.

```markdown
---
name: recommending-github-issues
description: Use when running as the dispatch recommender for a single GitHub repo. Triggers when invoked by middle-management with a state issue number and rate-limit context. The recommender's sole job is to rewrite the state issue body with a ranked dispatch plan and a needs-human digest, conforming to the agent-queue state issue schema. NEVER writes code, NEVER modifies non-state issues, NEVER opens PRs. If asked for anything other than a recommender run, decline and state this skill is recommender-only.
allowed-tools: Bash(gh:*), Bash(git:log:*), Bash(git:status), Read, Grep, Glob
---

# Recommending GitHub Issues

You are the dispatch recommender for a single GitHub repository. Your only job
is to rewrite ONE state issue's body with a ranked plan of work to dispatch and
a digest of items needing human attention.

## What you are

- A read-only analyst of one repo's issues, PRs, and recent history
- The producer of one specific GitHub issue's body (the state issue)
- A consumer of dispatcher-provided context: rate limits, in-flight, slot capacity

## What you are NOT

- An implementer. You do not write code. You do not create branches. You do not commit.
- A merger. You do not approve or merge PRs.
- A commenter on arbitrary issues. You write to ONE issue body. You may comment on
  the state issue itself to log run summaries. Nothing else.
- A labeler. You do not add or remove labels.
- A planner for any specific issue's implementation. That's the implementer's job.

If you find yourself wanting to do any of the above, STOP. Your output is the
state issue body and a one-line summary. That's it.

## Workflow

### Phase 1 — Receive context

The dispatcher provides via your prompt:
- `repo`: owner/name
- `state_issue`: integer issue number to rewrite
- `schema_path`: filesystem path to state-issue.v1.md
- `prior_body`: current contents of the state issue
- `rate_limits`: claude, codex, github statuses
- `in_flight`: array of currently running agents
- `slots`: { <adapter>: { used, max }, total: { used, max, global_used, global_max } }
- `config`: { default_adapter, complexity_ceiling, auto_dispatch }

Read all of it. Do not start `gh` calls until you've internalized prior_body and
the dispatcher inputs.

### Phase 2 — Fetch repo state

Run, in order:

\`\`\`bash
gh issue list --state open --limit 200 \\
  --json number,title,labels,assignees,body,comments,createdAt,updatedAt
gh pr list --state open --limit 100 \\
  --json number,title,labels,headRefName,isDraft,reviewDecision,statusCheckRollup,body,createdAt,updatedAt
\`\`\`

If >200 open issues, filter to `--label agent-queue:eligible` (document the filter
you used in your run-summary comment).

You may also `git log --oneline -50 main` to gauge recent merge cadence.

### Phase 3 — Classify each open issue

For every open issue NOT currently In-flight:

classify(issue) → { category, adapter, phases, reason }

**Category** is one of: `ready`, `needs-human`, `blocked`, `excluded`.

`ready` requires ALL:
- Acceptance criteria readable (explicit or strongly implicit)
- No open blockers
- No `needs-design`, `blocked`, `wontfix` labels
- Not assigned to a human
- Phases ≤ complexity_ceiling OR carries `approved` label
- A non-rate-limited adapter exists

`needs-human` means a human resolves the blocker:
- Ambiguous acceptance criteria
- PR awaiting human review
- Fork PRs both open with tie declared
- Size above ceiling without `approved`

`blocked` means another open issue must close first. Name blocker explicitly.

`excluded` is not ranked this cycle. Categories fixed (see schema).

**Adapter selection:**
1. Explicit `agent:<name>` label overrides
2. Else `config.default_adapter`
3. If chosen adapter rate-limited AND task portable, switch
4. Otherwise leave it; auto-dispatch skips it until reset

**Phase estimate:**
- Default 1 for genuinely single-concern issues
- +1 multiple subsystems touched
- +1 database/schema changes
- +1 new external API/service
- +1 refactor/migration keywords
- +0.5 explicit documentation requirement
- Round up. Be conservative. Over-estimation pushes big work to humans sooner.

**Reason** must fit ≤180 chars on one line. Be specific. "Acceptance criteria
clear; pattern matches #198; no blockers" is good. "Looks doable" is not.

### Phase 4 — Rank Ready

Sort by, in order:
1. Number of currently-blocked issues this would unblock
2. Sub-issue of currently-In-flight parent (continuity)
3. Smaller phase estimate breaks ties
4. Older updatedAt breaks remaining ties

Output top 5–8 only. Auto-dispatch loop re-runs after every state change;
depth beyond the working set is wasted.

### Phase 5 — Compose body

Render against the schema. Sections you don't own (In-flight, Rate limits,
Slot usage) come from dispatcher input verbatim — do not recompute them.

Verify before writing:
- Every #N reference resolves to a real open issue/PR
- Every adapter name is configured
- Ready table column header exact
- Section order matches schema
- Metadata block present, `generated` is current

### Phase 6 — Write and log

\`\`\`bash
gh issue edit <state_issue> --body-file <generated-body.md>
\`\`\`

Then post a single comment with the diff summary against prior_body:

> ## Run a3f8c10b summary
>
> **Promotions:**
> - #253 Blocked → Ready (parent #200 now in-flight)
>
> **Demotions:**
> - #259 Ready → Needs human input (issue updated 1h ago with ambiguity)
>
> **New entries:**
> - #266 — added to Needs human input (acceptance criteria missing)
>
> **No-change:** 12 other items kept classification.
>
> Rate-limit: claude AVAILABLE, codex LIMITED until 16:32Z, github 4180/5000.
> Slots: claude 1/2, codex 0/1, total 1/3, global 2/4.

If zero changes from prior body, post "No changes this run." — confirms the
recommender is alive without polluting timeline.

## Stop conditions

Done when:
1. State issue body parses against the schema
2. Diff comment posted (or no-change comment if applicable)
3. Every #N references a real issue/PR

If stuck (state issue malformed, missing, etc.): post one comment describing
the problem and stop. Dispatcher will surface to human.

## Red flags — STOP and self-correct

| Thought | Reality |
|---|---|
| "Let me open a PR to fix this issue while I'm here" | You implement nothing. |
| "Let me re-label these issues so they classify cleanly" | You change no labels. Document state as-is in reason. |
| "This issue is small enough to just do" | Still no. Implementer skill runs separately. |
| "I'll comment on issue #N for clarification" | Only the state issue is yours. Put the question in `needs-human` reason. |
| "Previous recommender got #253 wrong, let me explain at length" | One-line diff comment, move on. |
| "I'll include all 47 ready issues" | Cap 5–8. Auto-dispatch re-runs on state change. |
| "I'll guess phases without reading" | Read. Wrong estimate = wrong dispatch. |
| "I'll rewrite In-flight, it looks stale" | You don't own it. Copy dispatcher input verbatim. |
| "Let me add a new exclusion category" | Closed set. Schema bump required. |

## Files this skill creates

None on filesystem. Output is the state issue body via `gh issue edit` and one
diff comment via `gh issue comment`.

## Files this skill reads

- Schema at the path provided by the dispatcher
- Repo's open issues and PRs via `gh`
- Recent git log on main
- Source files when needed to estimate phases (skim, don't read fully)
```

---

## Adapter interface

```ts
// packages/core/src/adapter.ts

export interface AgentAdapter {
  readonly name: string;             // 'claude' | 'codex' | ...

  /** Write hook config + any per-CLI setup into the worktree. */
  installHooks(opts: InstallHookOpts): Promise<void>;

  /** Build the headless invocation. tmux runs this. */
  buildCommand(opts: SpawnOpts): {
    argv: string[];
    env: Record<string, string>;
  };

  /** Classify an exit + log tail. */
  classifyExit(opts: {
    exitCode: number;
    logTail: string;
    sentinelPresent: boolean;
  }): ExitClassification;

  /** Optional: detect rate-limit message in a Stop-hook payload. */
  detectRateLimit?(payload: HookPayload): RateLimitDetection | null;
}

export type InstallHookOpts = {
  worktree: string;
  hookScriptPath: string;       // .middle/hooks/hook.sh in the worktree
  dispatcherUrl: string;        // http://127.0.0.1:8822
  sessionName: string;
  sessionToken: string;         // HMAC token for hook auth
  issueNumber: number;
};

export type SpawnOpts = {
  worktree: string;
  promptFile: string;           // path on disk containing the agent prompt
  sessionName: string;
  sessionToken: string;
  envOverrides?: Record<string, string>;
};

export type ExitClassification =
  | { kind: 'done' }
  | { kind: 'asked-question'; sentinelPath: string }
  | { kind: 'rate-limited'; resetAt: string /* ISO */ }
  | { kind: 'failed'; reason: string }
  | { kind: 'idle-timeout' };

export type RateLimitDetection = {
  resetAt: string;
  source: 'exit' | 'stop-hook' | 'transcript';
};
```

### `ClaudeAdapter` specifics

- `buildCommand`: `["claude", "-p", "--permission-mode=auto", "--output-format=stream-json", "--prompt-file", promptFile]` plus a redirect to the logfile.
- `installHooks`: writes `<worktree>/.claude/settings.json` with hooks for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SubagentStop`, `SessionEnd`. Each entry runs `hook.sh <EventName>` and forwards stdin.
- `classifyExit`: matches log tail against `/You've hit your usage limit\. Resets at (.+?)\./` for rate limits. Checks `<worktree>/.middle/blocked.json` for question sentinel. Auto mode termination after 3 consecutive denials → `failed` with reason from the message.
- `detectRateLimit`: same regex applied to the `Stop` hook's transcript text.

### `CodexAdapter` specifics

- `buildCommand`: `["codex", "exec", "--json", "--sandbox=workspace-write", "--cd", worktree, "--", promptText]` — passes prompt as argv, not file (Codex prefers it). The `approval_policy = "never"` lives in `.codex/config.toml`, not the command line.
- `installHooks`: writes `<worktree>/.codex/config.toml` with a `[hooks]` block. Codex's hook event names differ; the adapter maps them to normalized events (see "Normalized events" below).
- `classifyExit`: matches Codex's rate-limit message (TBD — observe and add patterns as encountered; start with a generous `/rate.?limit|429|too many requests/i` and tighten).

---

## Normalized event taxonomy

All adapters emit these. The hook script POSTs `{type, sessionName, payload}` to the dispatcher.

| Event | Trigger (Claude) | Trigger (Codex) |
|---|---|---|
| `session.started` | SessionStart | startup hook |
| `turn.started` | UserPromptSubmit | turn-start hook |
| `tool.pre` | PreToolUse | command hook |
| `tool.post` | PostToolUse | command hook (success) |
| `tool.failed` | PostToolUseFailure | command hook (failure) |
| `agent.notification` | Notification | n/a |
| `agent.stopped` | Stop / SubagentStop | turn-end hook |
| `session.ended` | SessionEnd | shutdown hook |
| `rate-limit.detected` | (synthetic from Stop) | (synthetic from Stop) |

The hook script is uniform across both:

```sh
#!/bin/sh
# .middle/hooks/hook.sh — installed by `mm init`
# Args: $1 = normalized event name
EVENT="$1"
# Read JSON payload from stdin, POST to dispatcher with HMAC auth.
# Never block the agent. 3s timeout. Failure → exit 0 (no-op).
exec curl -sS -X POST "${MIDDLE_DISPATCHER_URL}/hooks/${EVENT}" \
  -H "X-Middle-Session: ${MIDDLE_SESSION}" \
  -H "X-Middle-Token: ${MIDDLE_SESSION_TOKEN}" \
  -H "X-Middle-Issue: ${MIDDLE_ISSUE}" \
  -H "Content-Type: application/json" \
  --data-binary @- --max-time 3 || exit 0
```

Env vars (`MIDDLE_DISPATCHER_URL`, `MIDDLE_SESSION`, `MIDDLE_SESSION_TOKEN`, `MIDDLE_ISSUE`) are set by tmux at spawn time via `tmux new-session -e KEY=val`.

---

## SQLite schema

`~/.middle/db.sqlite3`. Single file, WAL mode. Migrations live in `packages/dispatcher/src/db/migrations/` as numbered `.sql` files.

```sql
-- 001_initial.sql

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('implementation', 'recommender')),
  repo TEXT NOT NULL,           -- 'owner/name'
  issue_number INTEGER,         -- null for recommender
  adapter TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'running', 'waiting-human', 'rate-limited',
    'completed', 'compensated', 'failed', 'cancelled'
  )),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  bunqueue_execution_id TEXT,   -- foreign reference into bunqueue's tables
  worktree_path TEXT,
  session_name TEXT,
  session_token TEXT,
  pr_number INTEGER,
  pr_branch TEXT,
  last_heartbeat INTEGER,
  meta_json TEXT                -- adapter-specific scratch
);

CREATE INDEX idx_workflows_state ON workflows(state);
CREATE INDEX idx_workflows_repo ON workflows(repo);
CREATE INDEX idx_workflows_heartbeat ON workflows(last_heartbeat);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,           -- normalized event name
  payload_json TEXT,            -- truncated to 16KB
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE INDEX idx_events_workflow_ts ON events(workflow_id, ts);
CREATE INDEX idx_events_ts ON events(ts);    -- for retention scans

CREATE TABLE rate_limit_state (
  adapter TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('AVAILABLE', 'RATE_LIMITED', 'UNKNOWN')),
  reset_at INTEGER,             -- unix ms, null when AVAILABLE/UNKNOWN
  observed_at INTEGER NOT NULL,
  source TEXT,                  -- 'exit', 'stop-hook', 'manual'
  detail TEXT
);

CREATE TABLE repo_config (
  repo TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,    -- snapshot of .middle/config.toml at last sync
  state_issue_number INTEGER,
  last_recommender_run INTEGER,
  paused_until INTEGER,         -- if non-null, no auto-dispatch
  last_synced_at INTEGER NOT NULL
);

CREATE TABLE waitfor_signals (
  signal_name TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  created_at INTEGER NOT NULL,
  payload_json TEXT
);

CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY
);
INSERT INTO schema_version VALUES (1);
```

Retention: `events` older than 14 days are deleted on a daily cron. Completed `workflows` older than 30 days are archived (config-json + final state preserved; events dropped).

`mm doctor` reports row counts and recent retention runs.

---

## bunqueue workflows

### `implementation` workflow

```ts
// packages/dispatcher/src/workflows/implementation.ts

import { Workflow } from 'bunqueue/workflow';

export const implementationWorkflow = new Workflow<ImplementationInput>('implementation')
  .step('prepare-worktree', prepareWorktree, {
    compensate: cleanupWorktree,
  })
  .step('plan', spawnAgentForPlanPhase, {
    timeout: 30 * 60 * 1000,        // 30 min
    retry: 2,
  })
  .step('verify-plan-posted', verifyPlanCommentExists)   // skill enforcement
  .step('implement-loop', implementWithVerification, {
    timeout: 4 * 60 * 60 * 1000,    // 4 hr per attempt
    retry: 3,
    compensate: rollbackPR,
  })
  .branch((ctx) => ctx.steps['implement-loop'].outcome)
    .path('done', (w) => w
      .step('verify-acceptance-gate', verifyAcceptanceGate)  // skill enforcement
      .step('mark-pr-ready', markPRReady)
    )
    .path('asked-question', (w) => w
      .step('post-question-on-issue', postQuestionVisibility)
      .waitFor((ctx) => `issue-${ctx.input.issueNumber}-answered`, {
        timeout: 7 * 24 * 3600 * 1000,  // 1 week
      })
      .step('resume-with-answer', resumeAgent)
      // and loop back via re-enqueue
    )
    .path('rate-limited', (w) => w
      .step('reschedule-after-reset', rescheduleAfterReset)
    )
  .step('finalize', finalizeAndCleanup);
```

Each step is small, well-named, and individually testable. Compensations roll back PR changes (close draft, label `agent-blocked`), worktree cleanup, and session kill.

### `recommender` workflow

```ts
export const recommenderWorkflow = new Workflow<RecommenderInput>('recommender')
  .step('check-rate-limit', checkAdapterAvailable)
  .step('prepare-shallow-worktree', prepareShallowWorktree, {
    compensate: cleanupWorktree,
  })
  .step('build-prompt', buildRecommenderPrompt)   // injects rate-limit + in-flight + slots
  .step('spawn-recommender-agent', spawnRecommenderAgent, {
    timeout: 5 * 60 * 1000,         // 5 min hard cap
  })
  .step('verify-state-issue-parses', verifyStateIssueParses)
  .step('trigger-auto-dispatch', triggerAutoDispatch)
  .step('cleanup-worktree', cleanupWorktree);
```

Recommender uses its own dedicated slot (not counted against `maxConcurrent`).

---

## Skill enforcement gates

Three mechanical gates that turn the implementer skill's "principles" into "enforced rules":

### 1. Plan-comment guard

After the agent finishes its "plan" phase, the dispatcher reads the target issue and verifies a comment exists by the agent's account containing the plan body. If missing, the workflow fails with a clear reason ("Plan-comment guard: no plan comment found on issue #N").

### 2. PR-ready guard (Phase 10 gate, mechanically enforced)

A `PreToolUse` hook installed in the worktree matches `Bash` commands whose `tool_input.command` contains `gh pr ready`. When matched, the hook calls a dispatcher endpoint `/gates/pr-ready` with the PR number; the dispatcher:

1. Reads the PR body.
2. Walks the acceptance-criteria section.
3. For each criterion, verifies either evidence link OR `(deferred: <comment-url>)` annotation where the comment is by a non-bot user.
4. Returns `allow` (exit 0) or `deny` (exit 2 with reason).

If denied, the agent sees the reason and either fills the gap or requests deferral. Phase 10 of the skill is now genuinely a gate, not a suggestion.

### 3. Checkbox-revert

After every push by the agent, the dispatcher reads the PR body and inspects the "Status" checkbox list. If a checkbox transitioned `[ ] → [x]` for phase N, the dispatcher runs the verification gates for phase N (lint, typecheck, test, project-specific acceptance script). If any gate fails, the dispatcher reverts the checkbox (`gh pr edit --body-file ...`) and posts a comment naming the failed gate. The agent's next turn sees the revert and the failure context.

These three gates do not interfere with the agent's reasoning — they react to its outputs. The skill stays advisory; the dispatcher makes the advice binding.

---

## Watchdog

Bunqueue cron, runs every 30 seconds, reconciles three signals per `running` workflow:

1. **tmux liveness** — `tmux has-session -t <name>` and pane count. Dead session whose workflow is `running` → mark `failed` with reason `tmux session disappeared`. Trigger compensation.

2. **Heartbeat freshness** — `now - last_heartbeat`:
   - < `IDLE_THRESHOLD` (default 5 min): healthy
   - ≥ `IDLE_THRESHOLD`, < `IDLE_KILL_THRESHOLD` (default 15 min): mark `idle` in events; dashboard shows yellow
   - ≥ `IDLE_KILL_THRESHOLD`: `tmux kill-session`, mark workflow `failed` with reason `idle-timeout`. bunqueue retry decides whether to re-spawn.

3. **Sentinel files** — `<worktree>/.middle/blocked.json` exists but no `waitFor` signal armed for this workflow → re-arm the signal (handles a race where the agent wrote the sentinel after the workflow advanced).

The watchdog NEVER overrides "in progress" decisions made by hooks. Hooks update heartbeat first; watchdog only acts on staleness.

---

## Rate-limit detection (reactive, per the constraint)

Two sources, both reactive:

1. **Exit classifier** — adapter's `classifyExit` matches the log tail. On match, returns `{kind: 'rate-limited', resetAt}`. The workflow transitions to `rate-limited`; bunqueue re-enqueues with `delay: resetAt - now`.

2. **Stop-hook detector** — adapter's `detectRateLimit` runs against every Stop hook payload. If matched, fires a `rate-limit.detected` synthetic event with `resetAt`. The dispatcher updates `rate_limit_state` immediately even though the agent technically exited 0.

On detection:
- `rate_limit_state[adapter]` set to `{ status: 'RATE_LIMITED', reset_at, source }`
- All pending workflows for that adapter delayed to `reset_at + jitter`
- Auto-dispatch loop skips that adapter
- Dashboard banner goes amber

When `reset_at` passes:
- `rate_limit_state[adapter]` reverts to `AVAILABLE` after the next successful dispatch (probe-via-real-work)
- Manual override: dashboard button + `mm rate-limit clear claude`

GitHub limits are queried via `gh api rate_limit` every 60s by a separate cron. No reactive needed there.

---

## Auto-dispatch loop

Triggered after:
- Every recommender run completes
- Every workflow terminal-state transition
- Every rate-limit state change
- Manual `mm dispatch <repo>` invocation

```ts
async function autoDispatch(repo: string) {
  const state = await readStateIssue(repo);             // parsed from GitHub
  const limits = await loadConfig(repo).limits;
  const rateLimits = await getRateLimitState();
  const slots = await getSlotState(repo);
  if (!repoIsAutoDispatchEnabled(repo)) return;

  for (const row of state.readyToDispatch) {
    if (slots.globalAvailable === 0) break;
    if (rateLimits[row.adapter]?.status === 'RATE_LIMITED') continue;
    if (slots.byAdapter[row.adapter] === 0) continue;
    if (row.estPhases > limits.complexityCeiling
        && !await issueHasLabel(row.issueNumber, 'approved')) continue;

    await enqueueImplementationWorkflow({
      repo, issueNumber: row.issueNumber, adapter: row.adapter,
    });
    // Decrement local counters so the next row sees fresh state
    slots.byAdapter[row.adapter]--;
    slots.globalAvailable--;
  }
}
```

Manual force-dispatch (`mm dispatch <repo> <issue-num> --adapter <adapter>`) bypasses the ceiling and approval gates but still respects slot limits. Logged with `source: 'manual'`.

---

## Dashboard

HTTP server on `localhost:8822` (configurable). Single-page React app. Real-time updates via SSE.

### Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  ⏵ middle                                                        │
│  claude ✓ available   codex ⏸ 2h 14m   github ✓ 4180/5000  │  ← global banner
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  NEEDS YOU                                            4 items    │  ← top priority
│  ────────────────────────────────────────────────────────────   │
│  ↑ PR #251 (issue #247) — ready for review · 2h ago             │
│    OAuth refresh · all gates green                              │
│                                                                  │
│  ↑ Issue #266 — agent asked: "should refresh use sliding or     │
│    fixed window?" · 18m ago                          [open]     │
│                                                                  │
│  ↑ PR #248 + #249 (issue #244) — architectural fork TIED        │
│    IndexedDB vs OPFS · [compare]                                │
│                                                                  │
│  ↑ Issue #259 — flagged blocker for #260, #261                  │
│    "needs design decision on schema migration"                  │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  REPOS                                                           │
│  ────────────────────────────────────────────────────────────   │
│  retroforge       claude 2/2  codex 0/1  total 2/3   auto ✓    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ NEXT UP:                                                  │   │
│  │  1. #247 OAuth refresh · claude · 3 phases               │   │
│  │  2. #253 cache-warm tests · codex · 1 phase              │   │
│  │ IN FLIGHT:                                                │   │
│  │  #247 · claude · phase 2/3 · 14s ago    [tmux attach]   │   │
│  │  #253 · codex · running · 41s ago       [tmux attach]   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│  three-flatland   claude 1/2  codex 0/1  total 1/2   auto ✗    │
│  ...                                                             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Views

1. **Needs You** (the primary surface): aggregated from `needsHumanInput` across all repos, plus `Ready for review` PRs.
2. **Per-repo header** with slot pills and auto-dispatch toggle.
3. **Per-repo expansion**: NEXT UP (top 2 of ready) + IN FLIGHT (all currently running) + recent history (collapsed).
4. **Issue inspector** (modal/drawer): hook event timeline for a session, verification evidence, links to PR + worktree + tmux command.
5. **History** (collapsed by default): completed workflows from the last 7 days.
6. **Settings**: per-repo config editor, global config, manual rate-limit override buttons.

### SSE channels

- `/events/global` — global banner updates (rate limits, GitHub quota).
- `/events/repos/:repo` — per-repo events (state issue updated, slots changed, workflow transitions).
- `/events/sessions/:session` — per-session hook event stream for the inspector view.

### API

```
GET  /api/repos                            # list repos with summary state
GET  /api/repos/:repo                      # detailed repo state
POST /api/repos/:repo/run-recommender      # trigger recommender now
POST /api/repos/:repo/pause                # pause auto-dispatch
POST /api/repos/:repo/resume
POST /api/repos/:repo/dispatch             # manual dispatch a specific issue
POST /api/rate-limits/:adapter/clear       # manual override
GET  /api/sessions/:session/events         # paginated event history
GET  /api/sessions/:session/log            # tmux log file content (streamed)
```

### Optional windowed mode

`mm start --window` launches `webview-bun` against `localhost:8822` after the server is up. Adds ~50 lines of code. Defaults off.

---

## CLI reference

```
mm init <path>                  Bootstrap middle into a repo
mm uninit <path>                Remove middle from a repo
mm start [--window]             Start dispatcher
mm stop                         Stop dispatcher
mm status                       One-screen summary of all repos
mm doctor                       Health check + schema validation
mm attach <repo> <issue>        Print the tmux attach command
mm dispatch <repo> <issue>      Force-dispatch an issue
mm pause <repo>                 Pause auto-dispatch
mm resume <repo>
mm run-recommender <repo>       Trigger recommender now
mm slots <repo> --claude N --codex M --total T
mm rate-limit clear <adapter>   Manual override
mm log <session>                Stream a session's log
mm config <repo> <key> <value>  Set a config value
mm version
```

---

## Build sequence

Phased for dogfooding — by phase 3, middle is dispatching its own work.

### Phase 0 — Bootstrap repo (manual, no agents yet)

1. `bun init`, set up the monorepo, install dependencies.
2. Write `packages/state-issue/` first: types, parser, renderer.
3. **Fuzz test the parser/renderer round-trip.** Generate random valid states; assert `render(parse(render(state)))` is byte-identical. This is the foundation.
4. Write a hand-crafted state issue body fixture and check it in.

**Acceptance:** `bun test packages/state-issue` passes; fuzz runs ≥10,000 iterations clean.

### Phase 1 — Minimal dispatcher

5. SQLite migrations + db wrapper.
6. Config loader (global + per-repo, TOML).
7. `AgentAdapter` interface + `ClaudeAdapter` (only). Hooks NOT yet writing — just spawn + classify.
8. tmux helpers (spawn, has-session, kill, status).
9. Worktree helpers (create, destroy, list).
10. One bunqueue workflow: `implementation` with just 3 steps (worktree-prepare → spawn-agent → cleanup). No skill enforcement yet, no hooks.
11. `mm start`, `mm stop`, `mm status` CLI commands.

**Acceptance:** `mm dispatch <test-repo> <issue>` spawns Claude in tmux, agent runs, exits, workflow finalizes, worktree cleaned up.

### Phase 2 — Hooks + watchdog

12. Hook server (Bun.serve, /hooks/:event endpoint with HMAC validation).
13. `installHooks` for ClaudeAdapter writes `.claude/settings.json` referencing the universal `hook.sh`.
14. Universal `hook.sh` curl script.
15. Events table populated from incoming hooks. Heartbeats from `tool.pre`/`tool.post`.
16. Watchdog cron: tmux liveness + idle detection + sentinel check.
17. Reactive rate-limit detection in `classifyExit`.

**Acceptance:** Spawn an agent, watch hook events flow into SQLite. Kill the tmux session; watchdog catches it within 30s. Force a rate-limit error; dispatcher records reset_at correctly.

### Phase 3 — Bootstrap + skills + state issue

18. `mm init` and `mm uninit` commands.
19. Ship the canonical `implementing-github-issues` and `recommending-github-issues` skills under `packages/skills/`.
20. State issue creation as part of `mm init`.
21. State issue parser integrated; dispatcher can read/write its three sections.
22. **`mm init` middle into middle itself.** This is the dogfooding crossover.

**Acceptance:** `mm init .` on the middle repo creates a state issue, installs skills, hooks; `mm uninit .` cleanly removes everything. After `mm init`, you can manually create a GitHub issue in middle's repo, `mm dispatch . <issue>`, and middle dispatches an agent on its own repo.

From here forward, middle's remaining work is dispatched by middle.

### Phase 4 — Skill enforcement gates

23. Plan-comment guard.
24. PR-ready guard (PreToolUse on `gh pr ready`).
25. Checkbox-revert reconciler.

**Acceptance:** Dispatch an issue with deliberately bad agent behavior (skip plan comment); guard catches it. Try to flip a PR ready without all acceptance criteria; guard blocks. Tick a checkbox without passing gates; dispatcher reverts.

### Phase 5 — Human-in-loop

26. `waitFor` signal integration in the implementation workflow.
27. Sentinel-file detection in `classifyExit`.
28. GitHub comment poller (looks for human replies on issues with active wait signals).
29. Resume logic — re-spawn agent with the answer fed into the prompt.

**Acceptance:** Dispatch an issue. Agent writes blocked.json and exits. Dashboard shows "asked question." Reply on GitHub. Dispatcher signals the workflow. Agent re-spawns with the answer in context and continues.

### Phase 6 — Mechanical verification

30. Verification gate framework: per-repo `verify.toml` declares gate scripts.
31. Gate runner: executes each gate in the worktree, captures output.
32. Evidence posting: comments on the PR with gate results.
33. Integration with checkbox-revert.

**Acceptance:** After an agent push, dispatcher runs `pnpm typecheck`, `pnpm test`, project-specific acceptance script; results posted as PR comment with collapsed `<details>`. Failing gate reverts checkbox.

### Phase 7 — Recommender

34. `recommender` workflow.
35. Build-prompt step (injects rate-limit + in-flight + slots into the recommender's prompt).
36. Verify-state-issue-parses step.
37. Run-recommender CLI + dashboard button. **Read-only at first** — recommender writes; nothing auto-dispatches.
38. Hand-eyeball 3–5 recommender runs. Iterate the prompt.

**Acceptance:** Manual recommender run produces a state issue body that parses against the schema; the rankings match what you'd have picked yourself.

### Phase 8 — Auto-dispatch + limits

39. Slot tracking + enforcement in the dispatcher's enqueue path.
40. Auto-dispatch loop (triggered on the 4 events listed above).
41. Per-repo `auto_dispatch` toggle, pause/resume.
42. Complexity ceiling enforcement.
43. `approved` label override.

**Acceptance:** Enable auto-dispatch on middle's own repo. The recommender runs on cron; new issues auto-dispatch within their limits; nothing runs over the ceiling without `approved`.

### Phase 9 — Dashboard

44. Bun.serve + SPA wiring.
45. React app: Needs You + Repos + Inspector.
46. SSE channels.
47. Settings page.
48. Optional `--window` mode via webview-bun.

**Acceptance:** Dashboard at localhost:8822 shows live state; rate-limit banner updates within 2s of detection; tmux commands are copy-paste accurate.

### Phase 10 — CodexAdapter

49. `CodexAdapter` implementation (mirror of ClaudeAdapter).
50. Per-CLI adapter selection in implementer prompt + recommender.
51. Test that the adapter abstraction holds (or fix where it doesn't).

**Acceptance:** Dispatch the same issue twice, once each adapter, on a test repo; both produce conforming output. The adapter interface didn't need to change.

### Phase 11 — Operator polish

52. `mm doctor` — full health check.
53. Retention crons.
54. Backup script (SQLite + config).
55. README, docs under `docs/`.

**Acceptance:** A new user can clone middle, `bun install`, `mm start`, `mm init <a-repo-they-have>`, and have a working dispatch within 5 minutes.

---

## Dogfooding rules

These keep the dogfooding honest:

1. **From Phase 3 onward, every new feature is dispatched as a GitHub issue on middle's own repo.** No "I'll just hack it directly" — that's the whole point.

2. **The state issue is real from Phase 3.** It's not a test fixture; it's the live state of middle's development.

3. **Phase 4's skill enforcement gates apply to middle's own development.** When an agent works on middle, the gates fire on middle's PRs. This is the truest test of the skill enforcement: it has to be reasonable enough that the system can build itself under it.

4. **If middle blocks its own progress, that's signal.** A gate that's too tight will manifest as "I can't dispatch anyone to fix the gate." Fix the gate. The repo's own dispatch flow is the integration test.

5. **Phases 0–2 are manually written by you (or one agent dispatched outside middle).** Phases 3+ are dispatched through middle wherever possible. Bootstrap inevitably has a small chicken-and-egg moment; it ends at Phase 3.

6. **The recommender starts running on middle's repo at Phase 7.** From that point, the queue of remaining middle issues is itself the recommender's working set. If the recommender prioritizes badly, you see it immediately in your own dev experience.

---

## Things explicitly out of scope for v1

- Multi-machine / multi-user dispatcher (always local, single-user).
- Per-issue cost tracking (the dispatcher records timing; cost can be added later from CLI subscription side, but no proactive querying of undocumented endpoints).
- Cross-repo recommendation intelligence.
- Adapter switching mid-workflow (one adapter per workflow lifetime).
- A "merge for me" action (the human always merges).
- Slack/Discord notifications (the dashboard is the surface; add notifications later if needed).
- Anything other than read-only access by the recommender (no auto-labelling, no auto-prioritization on the issues themselves).

---

## Final notes for the implementing agent

- **The state-issue parser is the keystone.** Build it first, fuzz-test it, treat its byte-identical round-trip as an invariant. Many things downstream assume it works.
- **Dogfooding crossover at Phase 3 is intentional.** Don't optimize before then. Phases 0–2 can be rough; the dogfooding loop is what polishes everything from there.
- **The skills (`implementing-github-issues` and `recommending-github-issues`) are part of the build artifact.** Treat them with the same care as code. They're the contract the agents work under.
- **Rate-limit handling is reactive, not predictive.** No undocumented endpoints, no scraping account pages. If a limit is hit, catch it and wait. Visualize honestly: AVAILABLE / RATE LIMITED / UNKNOWN, not fake percentages.
- **Hooks are heartbeats and notifications, not workflow logic.** Workflows decide; hooks observe.
- **GitHub is the system of record.** SQLite is operational state only. Wiping SQLite must not lose anything important.
- **The dashboard's "Needs You" panel is the product.** If you can close the dashboard because nothing needs you, the system is working.

When you start, the first user-visible deliverable should be `mm init` on a test repo successfully creating a state issue and installing the skills + hooks. Everything else builds on that.
