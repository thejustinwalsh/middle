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
mm start            # start in the background
mm start --window   # also open the queue observability page once it is up
mm stop             # SIGTERM the recorded pid and clear the pidfile
```

To run the dispatcher in the foreground during development, use `scripts/dev.sh` instead of `mm start`. Set `MIDDLE_CONFIG` to point at a non-default config file.

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

`mm doctor` checks your *toolchain*; `mm verify-file-mode` checks the *file-mode dispatch loop* end to end. Run it after install and after a major merge — see [Live-smoke verification](dogfooding.md#live-smoke-verification) for what it covers, when to run `--live`, and how to read a failure.

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
| `mm start [--window]` | Start the dispatcher |
| `mm stop` | Stop the dispatcher |
| `mm status` | One-screen summary of repos and workflow states |
| `mm doctor [--fix]` | Full health check |
| `mm verify-file-mode [--live --repo <owner/name>]` | Verify the file-mode dispatch loop end to end (`--live` runs against real GitHub) |
| `mm dispatch <repo> <epic>` | Force-dispatch an Epic (or standalone issue) |
| `mm run-recommender <repo>` | Rank the backlog now (rewrites the state issue) |
| `mm pause <repo>` / `mm resume <repo>` | Pause / resume auto-dispatch for a repo |
| `mm config <repo> <key> <value>` | Set a per-repo config value |
| `mm docs <repo>` | Trigger a docs-harvester audit run (read-only) |
| `mm version` | Print the `mm` version |
