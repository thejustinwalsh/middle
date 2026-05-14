# middle-management — Build Spec

A local orchestration layer for agentic coding work. It dispatches Claude Code and Codex agents against GitHub **Epics** (issues with sub-issues), enforces a strict implementation workflow via skills the agents run, monitors agent health via hooks, and surfaces only what truly needs human attention. GitHub is the system of record; middle is the operator.

This document is the build spec. It's designed to be handed to an agent (or a developer) and built in a single workstream, **dogfooding from the first commit** — the repo building middle uses middle to dispatch its own remaining work.

---

## Glossary

- **middle** — the system. The CLI binary is `mm`. In prose, "middle" is fine.
- **dispatcher** — the long-running middle process. Houses the bunqueue engine, hook receiver, watchdog, recommender scheduler, and HTTP dashboard.
- **adapter** — implementation of a CLI agent: `claude`, `codex`, etc. Behind one interface (`AgentAdapter`).
- **Epic** — a GitHub issue that has sub-issues. The unit of dispatch and of human review. One Epic → one branch → one PR. See "Dispatch granularity".
- **sub-issue** — a GitHub issue with a parent Epic. Never dispatched alone; it is one phase of its Epic's workstream and one checkbox in the Epic's PR.
- **standalone issue** — an issue with neither parent nor children. Also a dispatch unit — effectively a one-phase Epic.
- **dispatch unit** — an Epic or a standalone issue. The thing the recommender ranks and the dispatcher spawns an agent against.
- **complexity** — the branching factor of an unresolved design decision (how many candidate forks are needed to answer it), NOT size or effort. See "Complexity and architectural forks".
- **workflow** — a bunqueue workflow execution. Two kinds: `implementation` (per dispatch unit — an Epic or standalone issue) and `recommender` (per repo, cron).
- **state issue** — one GitHub issue per repo, label `agent-queue:state`, whose body is the recommender's ranked output and the dashboard's primary read source.
- **worktree** — a git worktree under `~/.middle/worktrees/<repo>/epic-<n>/` (or `recommender/`), one per active workflow.
- **bootstrap / unbootstrap** — `mm init <repo>` installs middle's skills, hooks, and the state issue into a target repo. `mm uninit <repo>` removes them. Safe and reversible.

---

## Non-goals (stated up front)

1. **Not a multi-tenant SaaS.** Local only. One user. The user is logged into each CLI subscription themselves.
2. **No cross-repo intelligence.** One recommender per repo. Humans coordinate batches across repos.
3. **Not a chat UI for agents.** Agents run as interactive CLI sessions inside tmux, driven by the dispatcher via `tmux send-keys`. The dashboard is read-only on agent state, but the operator can attach to a live session (see "Dispatch lifecycle" → human takeover).
4. **Not a code reviewer.** Mechanical verification gates only. Humans review and merge PRs.
5. **No private storage of work data.** GitHub is the source of truth for issues, plans, decisions, evidence. middle's SQLite holds operational state only — agent heartbeats, workflow executions, rate-limit reactions. Wiping middle's SQLite must not lose anything important.
6. **No undocumented APIs for rate limits.** GitHub's `rate_limit` endpoint is fair game. For CLI subscriptions: reactive detection only (catch the error, extract the reset, wait).
7. **No headless dispatch mode.** middle dispatches agents as interactive tmux sessions only. A headless CLI flag (`claude -p` and the like) is a vendor-removable rug — middle does not depend on one and keeps no headless fallback path.

---

## Dispatch granularity — Epics, not issues

middle dispatches **Epics**, not individual issues. This is the load-bearing decision the rest of the spec assumes.

- **Epic** — a GitHub issue that has sub-issues. It is the unit of dispatch *and* the unit of human review. One Epic → one worktree → one branch → one PR.
- **Sub-issue** — a GitHub issue with a parent. It is **never** dispatched on its own. It is one *phase* of its Epic's workstream; its acceptance criteria become one checkbox in the Epic's PR Status list.
- **Standalone issue** — an issue with neither parent nor children. It is also a dispatch unit — effectively a one-phase Epic: one issue → one branch → one PR.
- middle distinguishes these from GitHub's native sub-issue graph (`gh api .../sub_issues`). No `epic` label is required, though a repo may add one for human scanning.

**Why Epic-granular.** Dispatching tiny issues means a human reviews and merges constantly — babysitting. The Epic is the natural review unit: an agent works *down* an Epic's sub-issues on a single branch, ticking each off as a phase, and the human reviews the whole Epic PR once. Contention is bounded by the Epic-level dependency graph — within a dependency chain one Epic-workstream is live at a time, and the next Epic unblocks when the prior Epic's PR merges. There is no inter-sub-issue merge gating; the agent self-sequences within the Epic.

**PR mode (the `pr_mode` seam).** v1 ships `pr_mode = "single"` — one PR per Epic, sub-issues as Status checkboxes. The spec keeps a `[repo].pr_mode` seam so a future `"stacked"` mode (one stacked PR per sub-issue, managed via Graphite / the `gt` CLI) can be added without re-architecting. Everything below assumes `"single"` unless explicitly noted.

**The recommender ranks Epics.** The state issue's "Ready to dispatch" table is a ranked list of Epics (plus standalone issues). The recommender never ranks a sub-issue on its own — sub-issues are scope *inside* an Epic, surfaced only as that Epic's phase list.

---

## Complexity and architectural forks

`complexity` is **not** a measure of size or effort. It is the **branching factor of an unresolved design decision** — how many candidate implementations must be built and compared to answer a question the agent cannot resolve from CLAUDE.md, repo skills, or project docs.

The implementer's **architectural-fork mechanic** (canonical text in `implementing-github-issues`) handles this: when a decision is genuinely unclear, the agent worktrees each candidate, builds a minimal POC, evaluates them against project fitness signals, and folds the winner back. A 2-way (A vs B) or 3-way (A vs B vs C) comparison is tractable — the agent can reason about it and pick a winner. A 4-way-or-more comparison usually means the question is under-specified; the agent cannot reliably choose.

`complexity_ceiling` (per-repo config, default **3**) is the **maximum fork branching factor the agent resolves autonomously**. It is **not** a pre-dispatch gate. The Epic dispatches and the agent works down its sub-issues; when a sub-issue surfaces a decision that would need more candidate forks than the ceiling, the agent **pauses at that sub-issue** — writes `.middle/blocked.json` and exits — and the workflow surfaces it for human review. The human resolves it by **scope reduction or clarification**, not by adjudicating N implementations.

The `approved` label, applied by a human to an Epic, records that the human has reviewed its scope and authorizes the agent to proceed past a complexity pause (make a best-judgment call within the ceiling rather than pausing again). It is the human's "I've seen the branching cost, go" signal — typically applied after resolving an earlier pause.

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
│   │   │   │   └── attach.ts       # prints `tmux attach -t ...` for an Epic
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
owner = "thejustinwalsh"
name = "middle"
default_branch = "main"
pr_mode = "single"                        # "single" (one PR per Epic) — v1. "stacked" reserved for a future Graphite/gt mode.

[limits]
max_concurrent = 3
max_concurrent_per_adapter = { claude = 2, codex = 1 }
complexity_ceiling = 3                     # max fork branching factor an agent resolves itself; beyond it, pause the sub-issue for a human. NOT size.

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
   ✓ middle initialized for thejustinwalsh/middle
     skills installed at .claude/skills/, .codex/skills/
     hook script at .middle/hooks/hook.sh
     state issue created: #142
     config: .middle/config.toml
     auto-dispatch: OFF (enable with `mm config thejustinwalsh/middle auto_dispatch true`)
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

Every `#<n>` reference in this body is an **Epic** or a **standalone issue** — the dispatch units. Sub-issues never appear on their own; they are surfaced only as an Epic's phase count and progress.

### 1. ## Ready to dispatch

Table with EXACTLY columns: | Rank | Epic | Adapter | Sub-issues | Reason |
- Rank: int starting at 1, sequential
- Epic: `#<n> <title>` (title truncated to 60 chars with …) — an Epic or a standalone issue
- Adapter: configured adapter name
- Sub-issues: int — count of open sub-issues (the Epic's phase count); `1` for a standalone issue
- Reason: ≤180 chars, single line, only backtick markdown
- Empty state: single row `| — | _no Epics ready_ | — | — | — |`

### 2. ## Needs human input

Bulleted list. Each: `- **#<n> <short label>** — <one-liner> · [link]`
Short labels (stable vocabulary): fork tied, ambiguous criteria, ready for review,
complexity pause, awaiting reply, blocking critical path
(`complexity pause` — an agent paused at a sub-issue whose decision needs more candidate forks than `complexity_ceiling`; resolve by scope reduction or clarification.)

### 3. ## Blocked

Bulleted list. `- **#<n>** waiting on #<blocker> · <context>`
`#<n>` and `#<blocker>` are Epics (or standalone issues). Non-issue blockers: `waiting on \`<description>\``

### 4. ## In-flight  [DISPATCHER-OWNED]

`- **#<n>** · <adapter> · <progress> · last heartbeat <rel> · [tmux: <session>]`
Progress: `sub-issue <m>/<n>` (which phase of the Epic the agent is on) or `running`
Empty: `- _no agents in flight_`

### 5. ## Excluded

`- **#<n>** <reason category> — <detail>`
Categories (closed set): assigned to human, needs-design label,
acceptance criteria missing, no open sub-issues, archived, out of scope

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

middle dispatches **Epics** (issues with sub-issues) and **standalone issues** —
never bare sub-issues. You rank dispatch units, not individual sub-issues. A
sub-issue is one phase inside its Epic's single-PR workstream; it is the
implementer's concern, not yours.

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
- `config`: { default_adapter, auto_dispatch, pr_mode }

Read all of it. Do not start `gh` calls until you've internalized prior_body and
the dispatcher inputs.

### Phase 2 — Fetch repo state and resolve the Epic graph

Run, in order:

\`\`\`bash
gh issue list --state open --limit 200 \\
  --json number,title,labels,assignees,body,comments,createdAt,updatedAt
gh pr list --state open --limit 100 \\
  --json number,title,labels,headRefName,isDraft,reviewDecision,statusCheckRollup,body,createdAt,updatedAt
\`\`\`

If >200 open issues, filter to `--label agent-queue:eligible` (document the filter
you used in your run-summary comment).

Then resolve the **dispatch-unit structure** from GitHub's native sub-issue graph
(`gh api /repos/{owner}/{repo}/issues/{n}/sub_issues`):
- An issue with sub-issues is an **Epic** — a dispatch unit.
- An issue with a parent is a **sub-issue** — NOT a dispatch unit. It is scope inside
  its Epic; never classify or rank it on its own.
- An issue with neither is a **standalone issue** — a dispatch unit (a one-phase Epic).

You may also `git log --oneline -50 main` to gauge recent merge cadence.

### Phase 3 — Classify each dispatch unit

For every **Epic and standalone issue** NOT currently In-flight (skip sub-issues entirely):

classify(unit) → { category, adapter, subIssueCount, reason }

**Category** is one of: `ready`, `needs-human`, `blocked`, `excluded`.

`ready` requires ALL:
- The unit has readable acceptance criteria — for an Epic, every open sub-issue has
  explicit or strongly-implicit criteria
- No open blockers (no open Epic this one waits on)
- No `needs-design`, `blocked`, `wontfix` labels on the Epic
- Not assigned to a human
- A non-rate-limited adapter exists

There is **no pre-dispatch complexity gate**. Complexity is the branching factor of
a design decision and is discovered at runtime — if an agent hits a decision needing
more forks than `complexity_ceiling`, it pauses that sub-issue and the dispatcher
surfaces it as `needs-human`. You do not estimate or gate on it here.

`needs-human` means a human resolves the blocker:
- Ambiguous acceptance criteria on the Epic or one of its sub-issues
- The Epic's PR is awaiting human review
- Fork PRs both open with tie declared
- An agent paused a sub-issue on a `complexity pause` (decision exceeded the ceiling)

`blocked` means another open Epic must close first. Name the blocker explicitly.

`excluded` is not ranked this cycle. Categories fixed (see schema). An Epic with no
open sub-issues is `excluded` (`no open sub-issues`) — it is effectively done.

**Adapter selection:**
1. Explicit `agent:<name>` label on the Epic overrides
2. Else `config.default_adapter`
3. If chosen adapter rate-limited AND task portable, switch
4. Otherwise leave it; auto-dispatch skips it until reset

**Sub-issue count** is not an estimate — it is the count of open sub-issues from the
Epic graph (the Epic's phase count). A standalone issue counts as `1`. Report it as-is.

**Reason** must fit ≤180 chars on one line. Be specific. "5 open sub-issues, criteria
clear, parent Epic #6 unblocked on merge" is good. "Looks doable" is not.

### Phase 4 — Rank Ready

Sort by, in order:
1. Number of currently-blocked Epics this one would unblock
2. Fewer open sub-issues breaks ties (smaller Epics clear faster)
3. Older updatedAt breaks remaining ties

Output top 5–8 only. Auto-dispatch loop re-runs after every state change;
depth beyond the working set is wasted.

### Phase 5 — Compose body

Render against the schema. Sections you don't own (In-flight, Rate limits,
Slot usage) come from dispatcher input verbatim — do not recompute them.

Verify before writing:
- Every #N reference resolves to a real open Epic, standalone issue, or PR — never a bare sub-issue
- Every adapter name is configured
- Ready table column header exact (`| Rank | Epic | Adapter | Sub-issues | Reason |`)
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
> - #253 Blocked → Ready (Epic #200 it waited on merged)
>
> **Demotions:**
> - #259 Ready → Needs human input (a sub-issue's criteria went ambiguous 1h ago)
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
3. Every #N references a real Epic, standalone issue, or PR

If stuck (state issue malformed, missing, etc.): post one comment describing
the problem and stop. Dispatcher will surface to human.

## Red flags — STOP and self-correct

| Thought | Reality |
|---|---|
| "Let me open a PR to fix this issue while I'm here" | You implement nothing. |
| "Let me re-label these issues so they classify cleanly" | You change no labels. Document state as-is in reason. |
| "This Epic is small enough to just do" | Still no. Implementer skill runs separately. |
| "I'll rank this sub-issue, it looks ready" | Sub-issues are never dispatch units. Rank its Epic, or nothing. |
| "I'll comment on issue #N for clarification" | Only the state issue is yours. Put the question in `needs-human` reason. |
| "Previous recommender got #253 wrong, let me explain at length" | One-line diff comment, move on. |
| "I'll include all 47 ready Epics" | Cap 5–8. Auto-dispatch re-runs on state change. |
| "I'll guess the sub-issue count" | Resolve the sub-issue graph. The count is a fact, not an estimate. |
| "Let me estimate this Epic's complexity and gate on it" | There is no pre-dispatch complexity gate. Complexity is discovered at runtime; the agent pauses if a decision exceeds the ceiling. |
| "I'll rewrite In-flight, it looks stale" | You don't own it. Copy dispatcher input verbatim. |
| "Let me add a new exclusion category" | Closed set. Schema bump required. |

## Files this skill creates

None on filesystem. Output is the state issue body via `gh issue edit` and one
diff comment via `gh issue comment`.

## Files this skill reads

- Schema at the path provided by the dispatcher
- Repo's open issues and PRs via `gh`, and the sub-issue graph via `gh api`
- Recent git log on main
- Source files when needed to assess Epic readiness (skim, don't read fully) — the
  sub-issue count comes from the graph, never from estimation
```

---

## Adapter interface

middle dispatches every agent as an **interactive CLI session inside tmux**. There is no headless mode. The adapter abstracts the per-CLI launch command, the prompt-delivery text, how to enter auto mode, how to locate and read the on-disk transcript, and how to classify a turn boundary.

```ts
// packages/core/src/adapter.ts

export interface AgentAdapter {
  readonly name: string;             // 'claude' | 'codex' | ...

  /** Write hook config + any per-CLI setup into the worktree. */
  installHooks(opts: InstallHookOpts): Promise<void>;

  /** Build the INTERACTIVE launch command. tmux runs this; it takes no prompt. */
  buildLaunchCommand(opts: LaunchOpts): {
    argv: string[];
    env: Record<string, string>;
  };

  /** The literal text to send-keys into the session to start or continue the
   *  agent — includes the `@`-reference to the on-disk prompt file. */
  buildPromptText(opts: {
    promptFile: string;              // path, relative to the worktree
    kind: 'initial' | 'resume' | 'answer';
  }): string;

  /** Put the ready session into auto mode — a launch flag or post-ready keystrokes. */
  enterAutoMode(opts: { sessionName: string }): Promise<void>;

  /** The normalized event that signals the CLI is ready for input. */
  readonly readyEvent: NormalizedEvent;

  /** Locate the on-disk session transcript from the ready/session hook payload. */
  resolveTranscriptPath(payload: HookPayload): string;

  /** Read activity, state, and context/token usage from the transcript. */
  readTranscriptState(transcriptPath: string): TranscriptState;

  /** Classify the agent's state at a Stop hook. */
  classifyStop(opts: {
    payload: HookPayload;
    transcriptPath: string;
    sentinelPresent: boolean;
  }): StopClassification;

  /** Optional: detect a rate-limit message in a Stop-hook payload or transcript. */
  detectRateLimit?(opts: {
    payload: HookPayload;
    transcriptPath: string;
  }): RateLimitDetection | null;
}

export type InstallHookOpts = {
  worktree: string;
  hookScriptPath: string;       // .middle/hooks/hook.sh in the worktree
  dispatcherUrl: string;        // http://127.0.0.1:8822
  sessionName: string;
  sessionToken: string;         // HMAC token for hook auth
  epicNumber: number;           // the Epic (or standalone issue) being dispatched
};

export type LaunchOpts = {
  worktree: string;
  sessionName: string;
  sessionToken: string;
  envOverrides?: Record<string, string>;
};

export type TranscriptState = {
  lastActivity: string;         // ISO
  contextTokens: number;        // for the context-overflow monitor
  turnCount: number;
  lastToolUse: string | null;
};

export type StopClassification =
  | { kind: 'done' }                                   // agent marked the PR ready
  | { kind: 'asked-question'; sentinelPath: string }
  | { kind: 'rate-limited'; resetAt: string /* ISO */ }
  | { kind: 'bare-stop' }                              // stopped, no sentinel, not done
  | { kind: 'failed'; reason: string };

export type RateLimitDetection = {
  resetAt: string;
  source: 'stop-hook' | 'transcript';
};
```

### `ClaudeAdapter` specifics

- `buildLaunchCommand`: `["claude"]` — interactive, no `-p`, no prompt. Env (`MIDDLE_*`) injected by tmux at spawn time.
- `buildPromptText`: returns a one-line `@`-reference that force-includes the on-disk prompt — `@.middle/prompt.md` (a single `@` prefixing the whole relative path). `kind: 'resume'` points additionally at `@planning/issues/<n>/plan.md` and `@.../decisions.md`; `kind: 'answer'` frames the human's reply.
- `enterAutoMode`: brings the session up in auto mode (the old `permission_mode = "auto"`). Mechanism is empirical — a launch flag if one is honored in interactive mode, otherwise `tmux send-keys S-Tab S-Tab`. The keystroke path is the guaranteed fallback.
- `readyEvent`: `session.started` (from the `SessionStart` hook).
- `resolveTranscriptPath`: reads `transcript_path` directly from the `SessionStart` hook payload.
- `readTranscriptState`: parses the JSONL transcript for last activity, turn count, last tool use, and cumulative context tokens.
- `classifyStop`: checks `<worktree>/.middle/blocked.json` for the question sentinel; matches the transcript tail against `/You've hit your usage limit\. Resets at (.+?)\./` for rate limits; reads PR state for `done`; otherwise `bare-stop`. Auto-mode termination after 3 consecutive denials → `failed` with the message reason.
- `detectRateLimit`: same usage-limit regex applied to the `Stop` hook transcript text.

### `CodexAdapter` specifics

- `buildLaunchCommand`: the interactive `codex` invocation (no `exec`). `approval_policy = "never"` and `sandbox = "workspace-write"` live in `.codex/config.toml`, not the command line.
- `buildPromptText`: Codex's force-include syntax for the on-disk prompt file (observed during the Codex phase).
- `enterAutoMode`, `readyEvent`, `resolveTranscriptPath`, `readTranscriptState`: Codex's launch flag / keystrokes, ready hook, and transcript location/format differ from Claude's and are filled in during Phase 10.
- `classifyStop`: matches Codex's rate-limit message (start with a generous `/rate.?limit|429|too many requests/i` and tighten as patterns are observed).

---

## Normalized event taxonomy

All adapters emit these. The hook script POSTs `{type, sessionName, payload}` to the dispatcher. Hooks are the **fast-path notification**; the authoritative state is the on-disk transcript, reconciled by a cron (see "Dispatch lifecycle").

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

Two events are **load-bearing for dispatch**, not merely observational:

- `session.started` carries `session_id` and `transcript_path` in its payload. It is how the dispatcher discovers the on-disk transcript at all, and it triggers the launch→drive transition (enter auto mode, confirm readiness, send the prompt).
- `agent.stopped` is the turn boundary the workflow reacts to. Because the interactive process does not exit between turns, this — not a process exit — is the signal the dispatcher classifies (`classifyStop`).

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
  -H "X-Middle-Epic: ${MIDDLE_EPIC}" \
  -H "Content-Type: application/json" \
  --data-binary @- --max-time 3 || exit 0
```

Env vars (`MIDDLE_DISPATCHER_URL`, `MIDDLE_SESSION`, `MIDDLE_SESSION_TOKEN`, `MIDDLE_EPIC`) are set by tmux at spawn time via `tmux new-session -e KEY=val`. `MIDDLE_EPIC` is the dispatched Epic (or standalone issue) number.

---

## SQLite schema

`~/.middle/db.sqlite3`. Single file, WAL mode. Migrations live in `packages/dispatcher/src/db/migrations/` as numbered `.sql` files.

```sql
-- 001_initial.sql

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('implementation', 'recommender')),
  repo TEXT NOT NULL,           -- 'owner/name'
  epic_number INTEGER,          -- the dispatched Epic or standalone issue; null for recommender
  adapter TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'launching', 'running', 'waiting-human', 'rate-limited',
    'completed', 'compensated', 'failed', 'cancelled'
  )),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  bunqueue_execution_id TEXT,   -- foreign reference into bunqueue's tables
  worktree_path TEXT,
  session_name TEXT,
  session_token TEXT,
  session_id TEXT,              -- the CLI's own session id, from the SessionStart hook
  transcript_path TEXT,         -- on-disk JSONL transcript; retained after the tmux session ends so --resume stays available
  controlled_by TEXT NOT NULL DEFAULT 'middle' CHECK (controlled_by IN ('middle', 'human')),
  current_sub_issue INTEGER,    -- which sub-issue/phase the agent is on; null for standalone
  pr_number INTEGER,            -- the one PR for this Epic
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

## Dispatch lifecycle

Every dispatch is **launch → drive → observe**. There is no headless mode and no exit code to read.

1. **Launch.** `tmux new-session -d` runs the interactive CLI (`claude`, no prompt) at a generous fixed size. Workflow state: `launching`.
2. **Drive.** The `SessionStart` hook fires — its payload yields `session_id` and `transcript_path`, recorded on the workflow row. The dispatcher runs `enterAutoMode`, tails the transcript to confirm the session is live and idle-ready (`capture-pane` is a thin fallback), then `send-keys` the adapter's prompt text (`@.middle/prompt.md`) followed by `Enter`. Workflow state: `running`.
3. **Observe.** The agent works; the process does not exit between turns. Each `Stop` hook is a turn boundary; the dispatcher runs `classifyStop` against the transcript + `.middle/blocked.json` sentinel + PR state.

### Transcript as the state channel

Interactive tmux gives no captured stdout. The CLI's on-disk JSONL **transcript** replaces it: `readTranscriptState` reads activity, turn boundaries, tool use, and context/token usage. Hooks are the fast-path notification; **crons and durable workers reconciling against the transcript are the source of truth** — a reconciler cron corrects any drift between what hooks reported and what the transcript shows.

### Sessions are slot-expensive

A live interactive session holds a concurrency slot; parallelism is scoped on active interactive sessions. So:

> **A session exists only while an agent is actively working. Any wait on something external — a human, a rate-limit reset — ends the session and frees the slot. Resume is a fresh session.**

```
[launching] ──launch timeout──▶ respawn (bounded)
   │ SessionStart hook → capture session_id + transcript_path
   ▼
[ready] ── enterAutoMode ── transcript confirms ──▶ send-keys "@.middle/prompt.md" + Enter
   ▼
[running] ◀── send-keys "continue" ──┐  ← only same-session continuation; preserves the
   │ Stop hook → classifyStop         │    session vs. a respawn. retry to a max, then kill.
   ├─ bare stop ──────────────────────┘
   ├─ asked-question ──▶ END SESSION (free slot) ▶ waiting-human ▶ resume
   ├─ done / PR ready ─▶ END SESSION (free slot) ▶ verification
   ├─ rate-limited ────▶ END SESSION (free slot) ▶ resume after reset
   ├─ context-overflow ▶ END SESSION (free slot) ▶ resume (fresh, always)
   └─ non-responsive ──▶ KILL SESSION ▶ resume (fresh, bounded)

   At any point in [running]:
   human takes control ─▶ controlled_by=human  (middle stops send-keys; watchdog
                          idle-kill suspended; slot still held)
                          └─ release ─▶ middle re-orients from transcript + PR ─▶ keeps driving
```

Slots count sessions in `launching` / `ready` / `running`. `END SESSION` decrements the slot immediately — that is what lets the auto-dispatch loop launch the next agent.

### Continuation mechanisms (cost-ordered)

Ending a tmux session frees the slot but does **not** burn the session: `session_id` and `transcript_path` stay on the workflow row, so `--resume` remains available. Resuming work picks the cheapest mechanism that preserves enough state:

1. **send-keys into the live session** — free. Only when no external wait occurred (the bare-stop nudge). Its value is session preservation: a cheap nudge before paying for a new session. Bounded retry, then kill + fresh respawn.
2. **Fresh session + reconstruction** — cheap. A new session re-primed from the workstream's own artifacts (`@planning/issues/<n>/plan.md`, `@.../decisions.md`, PR state). The default for resuming after any wait.
3. **`<cli> --resume <session-id>`** — costs tokens; rehydrates the transcript into context. The deliberate exception — used only when in-flight reasoning is honestly worth the tokens (verification "pump-to-finish" bounce-backs; quick-answered questions mid-reasoning). Never for context-overflow (rehydrates the bloat) or non-responsive recovery (the context may be the problem) — those always go fresh.

### Human takeover

A live session is something the operator can join (the dashboard surfaces the attach affordances — see "Dashboard"). The `workflows.controlled_by` column (`middle` | `human`) governs who drives:

- **Watch** — a read-only attach (`tmux attach -r`). No ownership change; middle keeps driving. Always safe — a read-only client cannot send input, so it never collides with `send-keys`.
- **Take control** — `controlled_by` flips to `human`. middle suspends `send-keys` driving for that session and the watchdog suspends idle-kill; the session keeps its slot. This is a pause, not an end.
- **Release** — an explicit operator action. A plain detach does not release (the operator may reattach). On release, middle re-reads the transcript + PR to re-orient, then resumes driving.
- If the operator ends the session while `controlled_by = human`, middle treats it as a deliberate manual conclusion — a human-decided terminal state, not `failed`/respawn.

The empirical unknown — whether `enterAutoMode` uses a launch flag or `S-Tab S-Tab` keystrokes — is abstracted behind the adapter and resolved during implementation; the keystroke path is the guaranteed fallback.

Full design rationale: `docs/superpowers/specs/2026-05-14-tmux-interactive-dispatch-design.md`.

---

## bunqueue workflows

### `implementation` workflow

One `implementation` workflow per **dispatch unit** — an Epic or a standalone issue. The agent is pointed at the Epic; the Epic's open sub-issues are the workstream's phases. One worktree, one branch, one PR for the whole Epic. Sub-issues are the PR's Status checkboxes — the workflow does NOT enqueue a workflow per sub-issue. (`pr_mode = "single"`; a future `"stacked"` mode would split this.)

```ts
// packages/dispatcher/src/workflows/implementation.ts

import { Workflow } from 'bunqueue/workflow';

export const implementationWorkflow = new Workflow<ImplementationInput>('implementation')
  // ImplementationInput: { repo, epicNumber, adapter }
  .step('prepare-worktree', prepareWorktree, {
    compensate: cleanupWorktree,
  })
  .step('resolve-sub-issues', loadEpicSubIssuesAsPlan)   // the Epic's open sub-issues = the phase list
  .step('plan', spawnAgentForPlanPhase, {
    timeout: 30 * 60 * 1000,        // 30 min
    retry: 2,
  })
  .step('verify-plan-posted', verifyPlanCommentExists)   // skill enforcement: plan comment on the Epic
  .step('implement-loop', implementWithVerification, {
    // agent works DOWN the sub-issues on one branch, ticking each as a phase
    timeout: 4 * 60 * 60 * 1000,    // 4 hr per attempt
    retry: 3,
    compensate: rollbackPR,
  })
  .branch((ctx) => ctx.steps['implement-loop'].outcome)
    .path('done', (w) => w
      .step('verify-acceptance-gate', verifyAcceptanceGate)  // skill enforcement: all sub-issue criteria
      .step('mark-pr-ready', markPRReady)
    )
    .path('asked-question', (w) => w
      // agent paused at a sub-issue — ambiguity, or a decision exceeding complexity_ceiling
      .step('post-question-on-issue', postQuestionVisibility)
      .waitFor((ctx) => `epic-${ctx.input.epicNumber}-answered`, {
        timeout: 7 * 24 * 3600 * 1000,  // 1 week
      })
      .step('resume-with-answer', resumeAgent)   // fresh session re-primed from plan.md/decisions.md/PR, or --resume when in-flight context is worth the tokens (see "Dispatch lifecycle")
      // and loop back via re-enqueue
    )
    .path('rate-limited', (w) => w
      .step('reschedule-after-reset', rescheduleAfterReset)
    )
  .step('finalize', finalizeAndCleanup);
```

Each step is small, well-named, and individually testable. The agent-spawning steps (`plan`, `implement-loop`) follow the launch → drive → observe model from "Dispatch lifecycle" — launch the interactive CLI, await readiness, `enterAutoMode`, `send-keys` the prompt, then react to `Stop` via `classifyStop`. Compensations roll back PR changes (close draft, label `agent-blocked`), worktree cleanup, and session kill. The `asked-question` path covers both an ambiguous sub-issue and a `complexity pause`: the agent pauses at the current sub-issue, the session **ends to free its slot**, the Epic's completed sub-issues stay done on the branch, and a human reply resumes the workstream as a fresh session (or `--resume`, per "Dispatch lifecycle").

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

The `spawn-recommender-agent` step is an interactive launch like any other (the recommender is still a short one-shot — it just runs interactively now). Recommender uses its own dedicated slot (not counted against `maxConcurrent`).

---

## Skill enforcement gates

Three mechanical gates that turn the implementer skill's "principles" into "enforced rules":

### 1. Plan-comment guard

After the agent finishes its "plan" phase, the dispatcher reads the **Epic** and verifies a comment exists by the agent's account containing the plan body (the plan covers the whole Epic — every sub-issue as a phase). If missing, the workflow fails with a clear reason ("Plan-comment guard: no plan comment found on Epic #N").

### 2. PR-ready guard (Phase 10 gate, mechanically enforced)

A `PreToolUse` hook installed in the worktree matches `Bash` commands whose `tool_input.command` contains `gh pr ready`. When matched, the hook calls a dispatcher endpoint `/gates/pr-ready` with the PR number; the dispatcher:

1. Reads the Epic PR body.
2. Walks the acceptance-criteria section — for an Epic PR this is the union of every sub-issue's acceptance criteria.
3. For each criterion, verifies either evidence link OR `(deferred: <comment-url>)` annotation where the comment is by a non-bot user.
4. Returns `allow` (exit 0) or `deny` (exit 2 with reason).

If denied, the agent sees the reason and either fills the gap or requests deferral. Phase 10 of the skill is now genuinely a gate, not a suggestion — and it gates the *whole Epic*, not a single sub-issue.

### 3. Checkbox-revert

After every push by the agent, the dispatcher reads the Epic PR body and inspects the "Status" checkbox list — **one checkbox per sub-issue**. If a checkbox transitioned `[ ] → [x]` for sub-issue N, the dispatcher runs the verification gates for that sub-issue (lint, typecheck, test, project-specific acceptance script). If any gate fails, the dispatcher reverts the checkbox (`gh pr edit --body-file ...`) and posts a comment naming the failed gate. The agent's next turn sees the revert and the failure context, and stays on that sub-issue.

These three gates do not interfere with the agent's reasoning — they react to its outputs. The skill stays advisory; the dispatcher makes the advice binding.

---

## Watchdog

Bunqueue cron, runs every 30 seconds, reconciles per `launching` and `running` workflow:

1. **Launch timeout** — a `launching` workflow whose `readyEvent` has not arrived within the launch timeout, or whose transcript never confirmed the prompt landed, is marked `failed` (reason `stuck-launching` or `prompt-not-accepted`). bunqueue retry decides whether to re-launch.

2. **tmux liveness** — `tmux has-session -t <name>` and pane count. A dead session whose workflow is `running` → mark `failed` with reason `tmux session disappeared`. Trigger compensation.

3. **Activity freshness** — `now - last_heartbeat`, cross-checked against transcript staleness (the interactive process never self-terminates, so staleness is the primary stuck-agent detector). **Skipped while `controlled_by = 'human'`** — a human-controlled session is not idle, it is being driven by the operator.
   - < `IDLE_THRESHOLD` (default 5 min): healthy
   - ≥ `IDLE_THRESHOLD`, < `IDLE_KILL_THRESHOLD` (default 15 min): mark `idle` in events; dashboard shows yellow
   - ≥ `IDLE_KILL_THRESHOLD`: `tmux kill-session`, mark workflow `failed` with reason `idle-timeout`. Resume is a fresh session.

4. **Sentinel files** — `<worktree>/.middle/blocked.json` exists but no `waitFor` signal armed for this workflow → re-arm the signal (handles a race where the agent wrote the sentinel after the workflow advanced).

A companion **reconciler cron** re-reads each `running` workflow's transcript and corrects any drift between what hooks reported and what the transcript shows — the transcript is the source of truth, hooks are the fast path.

The watchdog NEVER overrides "in progress" decisions made by hooks. Hooks and the transcript update activity first; the watchdog only acts on staleness.

---

## Rate-limit detection (reactive, per the constraint)

Two sources, both reactive, both at the `Stop` boundary (there is no process exit to classify):

1. **Stop classifier** — adapter's `classifyStop` matches the transcript tail. On match, returns `{kind: 'rate-limited', resetAt}`. The workflow ends the session, transitions to `rate-limited`, and bunqueue re-enqueues with `delay: resetAt - now`.

2. **Stop-hook detector** — adapter's `detectRateLimit` runs against every `Stop` hook payload + transcript. If matched, fires a `rate-limit.detected` synthetic event with `resetAt`; the dispatcher updates `rate_limit_state` immediately.

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

Each row of `state.readyToDispatch` is an **Epic** (or standalone issue) — one `implementation` workflow per row. There is **no pre-dispatch complexity gate**: complexity is the branching factor of a runtime design decision, discovered while the agent works (see "Complexity and architectural forks"). If a sub-issue's decision exceeds `complexity_ceiling`, the agent pauses *that sub-issue* and the workflow transitions to `waiting-human` — the loop never had to predict it.

```ts
async function autoDispatch(repo: string) {
  const state = await readStateIssue(repo);             // parsed from GitHub
  const rateLimits = await getRateLimitState();
  const slots = await getSlotState(repo);
  if (!repoIsAutoDispatchEnabled(repo)) return;

  for (const row of state.readyToDispatch) {            // each row is an Epic
    if (slots.globalAvailable === 0) break;
    if (rateLimits[row.adapter]?.status === 'RATE_LIMITED') continue;
    if (slots.byAdapter[row.adapter] === 0) continue;

    await enqueueImplementationWorkflow({
      repo, epicNumber: row.epicNumber, adapter: row.adapter,
    });
    // Decrement local counters so the next row sees fresh state
    slots.byAdapter[row.adapter]--;
    slots.globalAvailable--;
  }
}
```

Manual force-dispatch (`mm dispatch <repo> <epic-num> --adapter <adapter>`) still respects slot limits. Logged with `source: 'manual'`.

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
│  ↑ PR #251 (Epic #247) — ready for review · 2h ago              │
│    OAuth refresh · 4/4 sub-issues · all gates green             │
│                                                                  │
│  ↑ Epic #266 — agent paused sub-issue #271: "sliding or         │
│    fixed window?" · 18m ago                          [open]     │
│                                                                  │
│  ↑ PR #248 + #249 (Epic #244) — architectural fork TIED         │
│    IndexedDB vs OPFS · [compare]                                │
│                                                                  │
│  ↑ Epic #259 — flagged blocker for #260, #261                   │
│    "needs design decision on schema migration"                  │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  REPOS                                                           │
│  ────────────────────────────────────────────────────────────   │
│  retroforge       claude 2/2  codex 0/1  total 2/3   auto ✓    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ NEXT UP (Epics):                                          │   │
│  │  1. #247 OAuth refresh · claude · 4 sub-issues           │   │
│  │  2. #253 cache-warm tests · codex · 1 sub-issue          │   │
│  │ IN FLIGHT:                                                │   │
│  │  #247 · claude · sub-issue 2/4 · 14s ago  [watch][take] │   │
│  │  #253 · codex · running · 41s ago         [watch][take] │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│  three-flatland   claude 1/2  codex 0/1  total 1/2   auto ✗    │
│  ...                                                             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Views

1. **Needs You** (the primary surface): aggregated from `needsHumanInput` across all repos, plus `Ready for review` Epic PRs.
2. **Per-repo header** with slot pills and auto-dispatch toggle.
3. **Per-repo expansion**: NEXT UP (top 2 ready Epics) + IN FLIGHT (all running, with sub-issue progress) + recent history (collapsed).
4. **Epic inspector** (modal/drawer): the Epic's sub-issue checklist with per-sub-issue status, hook event timeline for the session, verification evidence, links to PR + worktree. Includes a **per-runner panel**: workflow state, `controlled_by`, tmux session name + liveness, last heartbeat, context-token usage, transcript path, and the attach affordances (see "Attaching to a live session").
5. **History** (collapsed by default): completed workflows from the last 7 days.
6. **Settings**: per-repo config editor, global config, manual rate-limit override buttons.

### Attaching to a live session

A live tmux session is joinable. The inspector exposes three affordances per runner:

- **Watch** — a read-only attach (`tmux attach -r`). Always safe; never collides with middle's `send-keys` driving.
- **Take control** — flips `controlled_by` to `human` (middle suspends driving; watchdog idle-kill suspends), then a read-write attach. Release is an explicit action; see "Dispatch lifecycle" → human takeover.
- **Copy command** — the raw `tmux attach -r -t <session>` (and the read-write variant) as copyable text — the guaranteed-portable fallback.

Watch / Take control POST to `POST /api/sessions/:session/attach`; the dispatcher (a local process) spawns the operator's terminal directly (e.g. `ghostty -e tmux attach …`). The exact spawn invocation is a small empirical detail; the copy-command path always works.

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
POST /api/repos/:repo/dispatch             # manual dispatch a specific Epic
POST /api/rate-limits/:adapter/clear       # manual override
GET  /api/sessions/:session/events         # paginated event history
GET  /api/sessions/:session/transcript     # on-disk JSONL transcript content (streamed)
POST /api/sessions/:session/attach         # spawn the operator's terminal; body: { mode: "watch" | "control" }
POST /api/sessions/:session/release        # return control to middle (controlled_by → middle)
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
mm attach <repo> <epic>         Print the tmux attach command for an Epic's session
mm dispatch <repo> <epic>       Force-dispatch an Epic (or standalone issue)
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

**Acceptance:** `mm dispatch <test-repo> <epic>` spawns Claude in tmux, agent runs, exits, workflow finalizes, worktree cleaned up.

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

**Acceptance:** `mm init .` on the middle repo creates a state issue, installs skills, hooks; `mm uninit .` cleanly removes everything. After `mm init`, you can manually create an Epic (an issue with sub-issues) in middle's repo, `mm dispatch . <epic>`, and middle dispatches an agent against it.

From here forward, middle's remaining work is dispatched by middle.

### Phase 4 — Skill enforcement gates

23. Plan-comment guard.
24. PR-ready guard (PreToolUse on `gh pr ready`).
25. Checkbox-revert reconciler.

**Acceptance:** Dispatch an Epic with deliberately bad agent behavior (skip plan comment); guard catches it. Try to flip the Epic PR ready without all sub-issue acceptance criteria; guard blocks. Tick a sub-issue checkbox without passing gates; dispatcher reverts.

### Phase 5 — Human-in-loop

26. `waitFor` signal integration in the implementation workflow.
27. Sentinel-file detection in `classifyExit`.
28. GitHub comment poller (looks for human replies on issues with active wait signals).
29. Resume logic — re-spawn agent with the answer fed into the prompt.

**Acceptance:** Dispatch an Epic. Agent pauses at a sub-issue — writes blocked.json and exits. Dashboard shows "asked question." Reply on GitHub. Dispatcher signals the workflow. Agent re-spawns with the answer in context and continues from that sub-issue.

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
40. Auto-dispatch loop (Epic-granular; triggered on the 4 events listed above).
41. Per-repo `auto_dispatch` toggle, pause/resume.
42. Runtime complexity-pause handling: a sub-issue decision exceeding `complexity_ceiling` routes the workflow to `waiting-human` (no pre-dispatch gate).
43. `approved` label handling: lets the agent proceed past a complexity pause on a human-reviewed Epic.

**Acceptance:** Enable auto-dispatch on middle's own repo. The recommender runs on cron; ready Epics auto-dispatch within their slot limits; a sub-issue whose decision exceeds `complexity_ceiling` pauses for human input rather than guessing.

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

**Acceptance:** Dispatch the same Epic twice, once each adapter, on a test repo; both produce conforming output. The adapter interface didn't need to change.

### Phase 11 — Operator polish

52. `mm doctor` — full health check.
53. Retention crons.
54. Backup script (SQLite + config).
55. README, docs under `docs/`.

**Acceptance:** A new user can clone middle, `bun install`, `mm start`, `mm init <a-repo-they-have>`, and have a working dispatch within 5 minutes.

---

## Dogfooding rules

These keep the dogfooding honest:

1. **From Phase 3 onward, every new feature is dispatched as a GitHub Epic on middle's own repo.** No "I'll just hack it directly" — that's the whole point. Small one-off work goes through a standalone issue (a one-phase Epic).

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
