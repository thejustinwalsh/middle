#!/usr/bin/env bash
# scripts/backup.sh — back up and restore middle's operational state.
#
# Captures middle's SQLite database and config into a single restorable
# .tar.gz, and restores from one. This is middle's OWN state only — its
# dispatch bookkeeping. It does NOT back up GitHub: issues, sub-issues, and PRs
# are the system of record and live on GitHub, not here.
#
# The database snapshot uses SQLite's `VACUUM INTO`, which produces a single
# consistent file even while the dispatcher is running against the live WAL —
# so you can back up without stopping `mm start`. (Restore, by contrast,
# requires the dispatcher stopped — see below.)
#
# Usage:
#   scripts/backup.sh [--home DIR] [--out DIR]      # create a backup archive
#   scripts/backup.sh --restore ARCHIVE [--home DIR] [--yes]
#
# Options:
#   --home DIR     middle home dir (default: $MIDDLE_HOME, else ~/.middle)
#   --db PATH      database to back up (default: the configured db_path, else
#                  <home>/db.sqlite3)
#   --out DIR      where to write the archive (default: current directory)
#   --restore ARCH restore from archive ARCH instead of backing up
#   --yes          skip the restore confirmation prompt
#   -h, --help     show this help
#
# Restore overwrites the db (and config) in --home. It refuses to run while the
# dispatcher is up — stop it first with `mm stop`. After restoring, start the
# dispatcher (`mm start`); it reopens the restored db and migrates if needed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="${MIDDLE_HOME:-$HOME/.middle}"
HOME_EXPLICIT=0
DB_OVERRIDE=""
OUT_DIR="."
RESTORE_ARCHIVE=""
ASSUME_YES=0

usage() { sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --home) HOME_DIR="${2:?--home needs a directory}"; HOME_EXPLICIT=1; shift 2 ;;
    --db) DB_OVERRIDE="${2:?--db needs a path}"; shift 2 ;;
    --out) OUT_DIR="${2:?--out needs a directory}"; shift 2 ;;
    --restore) RESTORE_ARCHIVE="${2:?--restore needs an archive path}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "backup.sh: unknown argument: $1" >&2; usage 1 ;;
  esac
done

# Resolve the db path so a relocated `db_path` isn't silently missed. Precedence:
#   1. --db PATH (explicit)
#   2. --home DIR → <DIR>/db.sqlite3 (the operator/test pinned a home)
#   3. the configured global.dbPath (honors MIDDLE_CONFIG + tilde), via the same
#      loader mm doctor uses; bun runs from the middle checkout so @middle/core resolves
#   4. <home>/db.sqlite3
resolve_db_path() {
  if [ -n "$DB_OVERRIDE" ]; then printf '%s' "$DB_OVERRIDE"; return; fi
  if [ "$HOME_EXPLICIT" -eq 1 ]; then printf '%s' "$HOME_DIR/db.sqlite3"; return; fi
  local p
  p="$(cd "$SCRIPT_DIR/.." && bun -e 'import{loadConfig}from"@middle/core";try{const d=loadConfig({globalPath:process.env.MIDDLE_CONFIG}).global.dbPath;if(d)process.stdout.write(d)}catch{}' 2>/dev/null)" || p=""
  if [ -n "$p" ]; then printf '%s' "$p"; else printf '%s' "$HOME_DIR/db.sqlite3"; fi
}

DB_PATH="$(resolve_db_path)"
CONFIG_PATH="${MIDDLE_CONFIG:-$HOME_DIR/config.toml}"
PID_FILE="$HOME_DIR/dispatcher.pid"

# Is the recorded dispatcher pid a live process?
dispatcher_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(tr -d '[:space:]' < "$PID_FILE")"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null
}

# Snapshot a live SQLite db to a clean single file via VACUUM INTO (consistent
# even with the WAL active — it reads a snapshot of the source without modifying
# it). bun is middle's runtime, so it is always present. The connection is
# read-write because VACUUM INTO needs a writable handle even though it only
# reads the source; concurrent with a running dispatcher this is safe under WAL.
snapshot_db() {
  # Paths go through the environment, not argv: `bun -e` does not expose trailing
  # positional args as process.argv, so argv-passing silently opens an in-memory db.
  MIDDLE_SNAP_SRC="$1" MIDDLE_SNAP_DST="$2" bun -e '
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.MIDDLE_SNAP_SRC);
    db.exec(`VACUUM INTO ${JSON.stringify(process.env.MIDDLE_SNAP_DST)}`);
    db.close();
  '
}

if [ -n "$RESTORE_ARCHIVE" ]; then
  # ---- restore ----
  [ -f "$RESTORE_ARCHIVE" ] || { echo "backup.sh: archive not found: $RESTORE_ARCHIVE" >&2; exit 1; }
  if dispatcher_running; then
    echo "backup.sh: dispatcher is running — stop it first with \`mm stop\`, then restore." >&2
    exit 1
  fi
  echo "About to restore middle state into: $HOME_DIR"
  echo "  from archive: $RESTORE_ARCHIVE"
  echo "  this overwrites $DB_PATH (and config.toml if present in the archive)."
  if [ "$ASSUME_YES" -ne 1 ]; then
    printf "Proceed? [y/N] "
    read -r reply
    case "$reply" in y|Y|yes|YES) ;; *) echo "Aborted."; exit 1 ;; esac
  fi
  mkdir -p "$HOME_DIR"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  tar -xzf "$RESTORE_ARCHIVE" -C "$tmp"
  [ -f "$tmp/db.sqlite3" ] || { echo "backup.sh: archive has no db.sqlite3 — not a middle backup?" >&2; exit 1; }
  # Drop stale WAL/SHM so the restored db is the single source of truth.
  rm -f "$DB_PATH-wal" "$DB_PATH-shm"
  cp "$tmp/db.sqlite3" "$DB_PATH"
  if [ -f "$tmp/config.toml" ]; then cp "$tmp/config.toml" "$CONFIG_PATH"; echo "  restored: config.toml"; fi
  echo "  restored: db.sqlite3"
  echo "Done. Start the dispatcher with \`mm start\` (it will migrate the db if needed)."
  exit 0
fi

# ---- backup ----
[ -f "$DB_PATH" ] || { echo "backup.sh: no database at $DB_PATH — nothing to back up." >&2; exit 1; }
mkdir -p "$OUT_DIR"
stamp="$(date +%Y%m%d-%H%M%S)"
archive="$OUT_DIR/middle-backup-$stamp.tar.gz"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Backing up middle state from: $HOME_DIR"
snapshot_db "$DB_PATH" "$tmp/db.sqlite3"
echo "  captured: db.sqlite3 (consistent snapshot)"
if [ -f "$CONFIG_PATH" ]; then
  cp "$CONFIG_PATH" "$tmp/config.toml"
  echo "  captured: config.toml"
else
  echo "  (no config.toml — using built-in defaults; nothing to capture)"
fi
tar -czf "$archive" -C "$tmp" .
echo "Wrote: $archive"
echo "Restore with: scripts/backup.sh --restore \"$archive\""
