# Architecture

middle is one long-running daemon that dispatches coding agents at GitHub Epics, plus a CLI to drive it. This document explains how the pieces fit and why the design is shaped the way it is. For how to operate it, see [operator.md](operator.md); for the agent-facing contract, see [adapters.md](adapters.md).

## The packages

middle is a Bun monorepo. Each package owns one concern.

- **`@middle/dispatcher`** — the long-running daemon. It owns the workflow engine, the SQLite store, the hook receiver, the SSE control feed, and every cron. `mm start` spawns it. The runnable entry is `packages/dispatcher/src/main.ts`.
- **`@middle/cli`** — the `mm` binary. Each subcommand delegates to a `run*` function and exits with its return code.
- **`@middle/core`** — shared types: the `AgentAdapter` interface, the config loader, the normalized hook-event taxonomy. No process-level side effects.
- **`@middle/state-issue`** — parse, render, and validate the GitHub **state issue**. The dispatcher edits it one section at a time, so the parser and renderer guarantee a byte-identical round-trip (see the root `CLAUDE.md`).
- **`@middle/adapter-claude`** — the shipped adapter; it launches and drives Claude Code. `@middle/adapter-codex` is a stub on the roadmap.
- **`@middle/dashboard`** — a React SPA plus `Bun.serve` route handlers, mounted on the dispatcher's port.

## One daemon, one port

The dispatcher composes the hook receiver and the dashboard onto a single port (default `4120`). `main.ts` starts the hook server with the dashboard's routes merged in, so an operator runs one process and visits one URL.

The server binds to `127.0.0.1` only. The hook receiver has no cryptographic auth and uses predictable session names, so a `0.0.0.0` bind would let any host on the network hijack a running workflow. Localhost-only is the security boundary.

## The dispatch lifecycle

Every dispatch is **launch → drive → observe**. There is no headless mode and no exit code to read — the agent runs as an interactive process that does not exit between turns.

1. **Launch.** `mm dispatch` (or the auto-dispatch loop) POSTs to `/control/dispatch`. The dispatcher checks slot limits and in-flight collisions, then starts an `implementation` workflow. The workflow creates a worktree and launches the agent in a detached `tmux` session running the interactive CLI with no prompt. State: `launching`.
2. **Drive.** The agent's `SessionStart` hook fires; its payload yields the session id and the transcript path, which the dispatcher records on the workflow row. The adapter answers the CLI's boot dialogs (`enterAutoMode`), then sends the dispatch prompt with `send-keys`. State: `running`.
3. **Observe.** The agent works. Each `Stop` hook is a turn boundary; the dispatcher classifies it (`classifyStop`) against the transcript, the `.middle/blocked.json` sentinel, and PR state — done, asked-a-question, rate-limited, or a bare stop.

### The transcript is the state channel

An interactive `tmux` session gives no captured stdout. The CLI's on-disk JSONL **transcript** replaces it: the adapter reads activity, turn boundaries, tool use, and token usage from the transcript file. Hooks are the fast-path notification; the transcript is the source of truth. A reconciler cron corrects any drift between what the hooks reported and what the transcript shows. The transcript is retained after the `tmux` session ends so `--resume` stays available.

## The crons

The daemon runs several recurring passes, each a bunqueue cron:

- **Watchdog** (every 30s) — the liveness safety net. It reconciles `launching`/`running` workflows: launch timeout, `tmux` liveness, activity freshness, and re-arming a `waitFor` signal when a blocked sentinel appeared after the workflow advanced. It acts on staleness only and never overrides an in-progress hook decision. Freshness checks are skipped while a session is human-controlled.
- **Poller** (every 60s) — for each parked workflow with an armed `waitFor`, it fires the resume signal when the unblocking event appears (a human reply, or a PR review verdict), and finalizes parked workflows whose Epic PR has merged or closed.
- **Recommender** (60s due-check) — runs the recommender for each managed repo whose configured interval has elapsed, ranking the backlog into the state issue.
- **Retention** (daily) — prunes old events and archives old completed workflows (see [operator.md](operator.md#retention)).
- **Epic-cache refresh** (every 60s) — refreshes the Epic browse cache the dashboard reads.

## SQLite is operational state; GitHub is the system of record

middle keeps two kinds of state in two places, deliberately.

**GitHub holds the work.** Epics, sub-issues, PRs, and the state issue live on GitHub. They survive a database reset because they were never middle's to lose.

**SQLite holds the bookkeeping.** `~/.middle/db.sqlite3` (WAL mode) tracks workflow rows, the event log, rate-limit state, the managed-repo registry, and the Epic cache. It is operational state — losing it loses in-flight tracking, not work. That is why `scripts/reset-db.sh` is safe by design and retention can prune freely: the durable record is always GitHub.

The schema is a sequence of numbered migrations under `packages/dispatcher/src/db/migrations/`, applied on daemon start. The core tables are `workflows`, `events`, `rate_limit_state`, `repo_config`, `waitfor_signals`, and `retention_runs`.

## Workflow states

A workflow row moves through a fixed set of states, enforced by a `CHECK` constraint:

`pending` → `launching` → `running`, then to a terminal state (`completed`, `compensated`, `failed`, `cancelled`) — or sideways into `waiting-human` (parked on a question or review) or `rate-limited` (the adapter hit a usage limit). The poller and watchdog move parked workflows back to `running` when the blocking condition clears.
