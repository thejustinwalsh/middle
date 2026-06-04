# Operator guide

Run middle day to day: start the dispatcher, put work on the board, watch it, and keep its state healthy. This guide assumes you have installed the prerequisites and linked the `mm` CLI — see the [README](../README.md) if you have not.

## The daily loop

```bash
mm doctor                       # check the toolchain and middle's own state
mm start                        # start the dispatcher (hook server + workflow engine)
mm dispatch <repo-path> <epic>  # hand an Epic to an agent
mm status                       # see who is working, blocked, or parked
mm stop                         # shut the dispatcher down
```

`<repo-path>` is a path to a **local checkout** of the target repo, not an `owner/name` slug. `<epic>` is an Epic (or standalone issue) number in that repo.

## Start and stop the dispatcher

`mm start` spawns the dispatcher as a background process and records its pid in `~/.middle/dispatcher.pid`. The dispatcher serves the hook receiver and the dashboard on one port (default `4120`, set by `global.dispatcher_port`).

```bash
mm start              # start in the background
mm start --window     # also open the queue observability page once it is up
mm start --foreground # run in-process, no pidfile (for a service manager — see below)
mm stop               # SIGTERM the recorded pid and clear the pidfile
```

`mm start --foreground` runs the dispatcher in-process without forking or writing a pidfile, so a service manager owns its lifecycle — that's the command the systemd/launchd templates use. To have middle come up on boot, restart on crash, and log durably, run it as a service: see [Run middle as a system service](daemon-as-a-service.md). For a quick foreground run during development you can also use `scripts/dev.sh`. Set `MIDDLE_CONFIG` to point at a non-default config file.

## Dispatch work

```bash
mm dispatch <repo-path> <epic>   # force-dispatch one Epic now
```

A dispatch creates a fresh worktree, launches the agent in a `tmux` session, hands it the dispatch brief (`.middle/prompt.md`), and drives it through the Epic's sub-issues. The agent pushes commits to one draft PR and, when every phase passes its gates, flips the PR to ready-for-review and posts a reviewer's brief. middle never merges — that is yours.

To let middle pick work itself instead of dispatching by hand, turn on auto-dispatch and the recommender for a repo (both default off):

```bash
mm config <repo-path> auto_dispatch true   # let the recommender's ranked work auto-dispatch
mm run-recommender <repo-path>              # rank the backlog now (rewrites the state issue; dispatches nothing)
```

The recommender rewrites the repo's **state issue** — a single GitHub issue holding the ranked dispatch plan and a needs-human digest. `mm run-recommender` is read-only with respect to dispatch: it ranks, it does not launch.

## Enable file mode on an existing repo

By default an Epic is a **GitHub issue** and the dispatch state is a GitHub **state issue** (github mode). In **file mode** an Epic is instead a Markdown file under `planning/epics/`, and the ranked dispatch state is the local file `.middle/state.md` — no Epic issues, no state issue. PRs still go to GitHub; only where Epics and dispatch state *live* changes.

Flip a repo that is already bootstrapped (or bootstrap a fresh one) into file mode with one command — `mm init` writes the local scaffold **and** the matching daemon-db row that the dispatcher routes on:

```bash
mm stop                                  # if the dispatcher is running
mm init <repo-path> --epic-store=file    # idempotent: re-init flips the mode
mm start
```

`mm init --epic-store=file` is idempotent — re-running it on a github-mode repo refreshes the skills and hooks, preserves your committed `.middle/policy.toml`, and adds the file-mode pieces. It writes the per-repo `[epic_store]` config to `.middle/<owner>-<name>.toml`:

```toml
[epic_store]
mode = "file"
epics_dir = "planning/epics"
state_file = ".middle/state.md"
```

That TOML is the human-readable record of the mode; `mm init` writes it together with the daemon-db row the dispatcher's gateway reads. **Hand-editing the TOML alone does not switch modes** — the dispatcher routes on the db row, so re-run `mm init --epic-store=file` rather than editing the file by hand.

After init, the repo has:

```text
planning/epics/        # one <slug>.md per Epic (README.md explains the format)
.middle/state.md       # the ranked dispatch state (the file-mode "state issue")
.middle/<owner>-<name>.toml   # the [epic_store] config above
```

Commit `planning/epics/` and `.middle/state.md` — they are the repo's Epics and dispatch state, not throwaway cache.

### Worked example

Author an Epic by dropping a file into `planning/epics/`. The filename stem is the Epic's slug — this is `planning/epics/retry-webhooks.md`:

```md
<!-- middle:epic v1 -->
# Retry failed webhooks

<!-- middle:meta
slug: retry-webhooks
approved: true
-->

## Context

Failed webhook deliveries are dropped on the floor. Retry them with backoff.

## Acceptance criteria

- [ ] Failed deliveries retry with exponential backoff
- [ ] A delivery that exhausts its retries lands in a dead-letter table

## Sub-issues

<!-- middle:sub-issue id=1 -->
- [ ] **1 — Retry queue**
  Persist failed deliveries and retry them with capped exponential backoff.
<!-- /middle:sub-issue -->

<!-- middle:conversation -->
<!-- /middle:conversation -->
```

The `<!-- middle:… -->` markers are the structural contract — write your prose *between* them; the dispatcher owns the marker lines. `mm doctor` round-trips every Epic file and fails on a malformed one, so a typo surfaces before a dispatch does. Dispatch it by **slug**, not issue number:

```bash
mm dispatch <repo-path> retry-webhooks
```

### What changes in file mode

- **References are slugs, not `#numbers`.** `mm dispatch`, `mm status`, and the dashboard show `retry-webhooks`, not `#123`.
- **The recommender ranks files.** `mm run-recommender` ranks the Epic files under `planning/epics/` and rewrites `.middle/state.md` instead of the GitHub state issue. The dispatcher's poller picks up state changes on its normal cadence (≈120s), same as github mode.
- **PRs are unchanged.** The agent still opens a GitHub PR per Epic and drives it to ready-for-review; only the Epic and dispatch state are local.
- **Verify with `mm doctor`.** In file mode `mm doctor` checks that `epics_dir` and `state_file` exist and that every Epic file round-trips, in place of the github-mode state-issue check (see [Run the health check](#run-the-health-check)).

## Pause and resume a repo

```bash
mm pause <repo-path>    # stop auto-dispatching this repo (in-flight work continues)
mm resume <repo-path>   # clear the pause
```

Pausing sets `repo_config.paused_until`; the auto-dispatch loop skips paused repos. It does not touch work already in flight.

## Read `mm status`

`mm status` prints a one-screen summary of every managed repo and the state of its workflows. Workflow states are: `pending`, `launching`, `running`, `waiting-human`, `rate-limited`, `completed`, `compensated`, `failed`, `cancelled`. A workflow in `waiting-human` is parked on a question or a review — it needs you.

## Run the health check

`mm doctor` is the command to run when something feels off. It checks:

- the external tools every dispatch shells out to — `bun`, `tmux` (≥ 3.5), `claude`, `git`, `gh`, and `gh` auth;
- whether the `mm` symlink's directory is on your `PATH` (`--fix` writes the export to your shell rc);
- that your config files parse;
- that the dispatcher is reachable on its port;
- that the state-issue parser still round-trips against `schemas/state-issue.v1.md`;
- SQLite row counts and the most recent retention run;
- repo-convention drift (skills mirror, module-index frontmatter, TSDoc coverage).

```bash
mm doctor          # report; exit non-zero if any check fails
mm doctor --fix    # also append the bun PATH export to ~/.zshrc / ~/.bashrc
```

Each check is pass (`✓`), warn (`!`), or fail (`✗`). Warnings mean degraded-but-functional; the command exits non-zero only on a failure.

## Back up and restore state

middle's SQLite database holds operational bookkeeping — workflow rows, the event log, rate-limit state. GitHub holds the work itself (issues, sub-issues, PRs), so a backup captures middle's state, never GitHub's.

```bash
scripts/backup.sh                          # write middle-backup-<timestamp>.tar.gz to the current dir
scripts/backup.sh --out ~/backups          # choose where the archive lands
scripts/backup.sh --restore <archive>      # restore (refuses while the dispatcher is up)
```

The backup snapshots the live database with SQLite's `VACUUM INTO`, so it is consistent even while the dispatcher runs — you do not have to stop it to back up. Restoring overwrites the database and refuses to run while the dispatcher is up; stop it with `mm stop` first, then `mm start` after (the dispatcher migrates the restored db if needed).

## Reset the database

```bash
scripts/reset-db.sh          # delete the db (+ -wal/-shm) after a confirmation prompt
scripts/reset-db.sh --yes    # skip the prompt
```

`reset-db.sh` refuses while the dispatcher is running, lists exactly what it will delete, and confirms first. The dispatcher recreates an empty, migrated database on the next `mm start`. It never touches GitHub — a reset loses in-flight workflow rows and the event log, not work. Back up first with `scripts/backup.sh`.

## Retention

The dispatcher runs a daily retention cron so operational state does not grow without bound:

- `events` rows older than 14 days are deleted;
- `completed` workflows older than 30 days are archived — their events are dropped, while the row, its final state, and its config snapshot are preserved.

Retention touches only middle's SQLite. `mm doctor`'s `database` line reports the most recent retention run.

## Command reference

| Command | What it does |
|---|---|
| `mm init <path>` | Bootstrap middle into a repo (skills, hooks, config, state issue) |
| `mm uninit <path>` | Remove middle from a repo |
| `mm start [--foreground] [--window]` | Start the dispatcher (`--foreground` for a service manager) |
| `mm stop` | Stop the dispatcher |
| `mm status` | One-screen summary of repos and workflow states |
| `mm doctor [--fix]` | Full health check |
| `mm dispatch <repo> <epic>` | Force-dispatch an Epic (or standalone issue) |
| `mm run-recommender <repo>` | Rank the backlog now (rewrites the state issue) |
| `mm pause <repo>` / `mm resume <repo>` | Pause / resume auto-dispatch for a repo |
| `mm config <repo> <key> <value>` | Set a per-repo config value |
| `mm docs <repo>` | Trigger a docs-harvester audit run (read-only) |
| `mm version` | Print the `mm` version |
