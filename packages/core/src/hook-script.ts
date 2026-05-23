/**
 * The universal hook script — the single source of truth for the small,
 * adapter-agnostic shell script every hook entry calls. It POSTs the hook
 * payload (read from stdin) to the dispatcher and must never block or fail the
 * agent. Source of truth: build spec → "Normalized event taxonomy".
 *
 * This constant is canonical. Two physical copies are kept byte-identical to it
 * and guarded by a drift test:
 *   - `packages/cli/src/bootstrap-assets/hooks/hook.sh` — what `mm init` stamps
 *     into a target repo (Phase 3).
 *   - the copy the adapter writes into each worktree at install time.
 *
 * Implementation note: curl runs as a child (not `exec`) so the trailing
 * `|| true` actually fires. With `exec`, the shell is replaced by curl and a
 * non-zero curl exit (refused connection, 3s timeout, DNS) would propagate as a
 * failed hook. As a child, any curl failure is swallowed and the hook exits 0 —
 * "failure is a no-op", which is the hard requirement (a hook must never block
 * or fail the agent).
 */
export const HOOK_SH = `#!/bin/sh
# .middle/hooks/hook.sh — POSTs hook payloads to the middle dispatcher.
# Args: $1 = normalized event name. Never blocks the agent; failure is a no-op.
EVENT="$1"
curl -sS -X POST "\${MIDDLE_DISPATCHER_URL}/hooks/\${EVENT}" \\
  -H "X-Middle-Session: \${MIDDLE_SESSION}" \\
  -H "X-Middle-Token: \${MIDDLE_SESSION_TOKEN}" \\
  -H "X-Middle-Epic: \${MIDDLE_EPIC}" \\
  -H "Content-Type: application/json" \\
  --data-binary @- --max-time 3 || true
exit 0
`;
