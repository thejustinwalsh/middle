#!/usr/bin/env bash
# scripts/reset-db.sh — nuke middle's SQLite database.
#
# Deletes middle's operational database (db.sqlite3 + its -wal/-shm sidecars).
# The dispatcher recreates and migrates a fresh, empty db on the next
# `mm start`. This wipes ONLY middle's local bookkeeping — it does NOT touch
# GitHub. Issues, sub-issues, and PRs are the system of record and live on
# GitHub; a reset loses in-flight workflow rows and the event log, not work.
#
# Usage:
#   scripts/reset-db.sh [--home DIR] [--yes]
#
# Options:
#   --home DIR   middle home dir (default: $MIDDLE_HOME, else ~/.middle)
#   --yes, -y    skip the confirmation prompt
#   -h, --help   show this help
#
# Safety: refuses to run while the dispatcher is up (stop it with `mm stop`),
# lists exactly what it will delete, and confirms before deleting unless --yes.
# Back up first with: scripts/backup.sh
set -euo pipefail

HOME_DIR="${MIDDLE_HOME:-$HOME/.middle}"
ASSUME_YES=0

usage() { sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --home) HOME_DIR="${2:?--home needs a directory}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "reset-db.sh: unknown argument: $1" >&2; usage 1 ;;
  esac
done

DB_PATH="$HOME_DIR/db.sqlite3"
PID_FILE="$HOME_DIR/dispatcher.pid"

dispatcher_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(tr -d '[:space:]' < "$PID_FILE")"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null
}

if dispatcher_running; then
  echo "reset-db.sh: dispatcher is running — stop it first with \`mm stop\`, then reset." >&2
  exit 1
fi

# Collect the files that actually exist, so the report is honest.
targets=()
for f in "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"; do
  [ -f "$f" ] && targets+=("$f")
done

if [ "${#targets[@]}" -eq 0 ]; then
  echo "reset-db.sh: no database at $DB_PATH — nothing to reset."
  exit 0
fi

echo "This will permanently delete middle's local database (GitHub is NOT touched):"
for f in "${targets[@]}"; do
  size="$(du -h "$f" 2>/dev/null | cut -f1)"
  echo "  - $f (${size:-?})"
done
echo "The dispatcher will recreate an empty, migrated db on the next \`mm start\`."

if [ "$ASSUME_YES" -ne 1 ]; then
  printf "Proceed? [y/N] "
  read -r reply
  case "$reply" in y|Y|yes|YES) ;; *) echo "Aborted."; exit 1 ;; esac
fi

rm -f "${targets[@]}"
echo "Done — deleted ${#targets[@]} file(s). GitHub was not touched."
