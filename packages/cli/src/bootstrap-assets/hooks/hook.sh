#!/bin/sh
# .middle/hooks/hook.sh — POSTs hook payloads to the middle dispatcher.
# Args: $1 = normalized event name. Never blocks the agent; failure is a no-op.
EVENT="$1"
curl -sS -X POST "${MIDDLE_DISPATCHER_URL}/hooks/${EVENT}" \
  -H "X-Middle-Session: ${MIDDLE_SESSION}" \
  -H "X-Middle-Token: ${MIDDLE_SESSION_TOKEN}" \
  -H "X-Middle-Epic: ${MIDDLE_EPIC}" \
  -H "Content-Type: application/json" \
  --data-binary @- --max-time 3 || true
exit 0
