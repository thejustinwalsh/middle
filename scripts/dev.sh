#!/bin/sh
# scripts/dev.sh — start the middle dispatcher in dev mode (foreground, this
# repo's own checkout). Set MIDDLE_CONFIG to point at a non-default config.
set -e
cd "$(dirname "$0")/.."
exec bun run packages/dispatcher/src/main.ts "$@"
