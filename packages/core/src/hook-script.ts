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

/**
 * The PR-ready guard's PreToolUse hook (skill enforcement gate #2). Unlike
 * `HOOK_SH` — which fires-and-forgets for every event — this one is a *blocking*
 * gate registered only for the Bash tool. It forwards the PreToolUse payload to
 * the dispatcher's `/gates/pr-ready` endpoint, which matches `gh pr ready` and
 * walks the Epic PR's acceptance criteria.
 *
 * Exit-code contract (Claude `PreToolUse`): exit 0 allows the tool; exit 2 blocks
 * it and feeds stderr back to the agent as the reason. So:
 *   - HTTP 200 → allow → exit 0
 *   - HTTP 4xx/5xx → deny → reason (response body) to stderr, exit 2 (blocks)
 *   - unreachable dispatcher (curl code 000) → fail OPEN (exit 0), never wedge
 *     the agent on an infra hiccup. A real deny only comes from a reachable
 *     dispatcher returning a 4xx/5xx.
 * The dispatcher does the command matching, so a non-`gh pr ready` Bash call is
 * allowed cheaply (a 200 without touching GitHub).
 */
export const PR_READY_GATE_SH = `#!/bin/sh
# .middle/hooks/pr-ready-gate.sh — blocking PreToolUse gate for \`gh pr ready\`.
# Forwards the payload to the dispatcher; exit 2 (with reason on stderr) blocks.
OUT=$(mktemp)
CODE=$(curl -sS -o "$OUT" -w '%{http_code}' \\
  -X POST "\${MIDDLE_DISPATCHER_URL}/gates/pr-ready" \\
  -H "X-Middle-Session: \${MIDDLE_SESSION}" \\
  -H "X-Middle-Token: \${MIDDLE_SESSION_TOKEN}" \\
  -H "X-Middle-Epic: \${MIDDLE_EPIC}" \\
  -H "Content-Type: application/json" \\
  --data-binary @- --max-time 15)
case "$CODE" in
  200) rm -f "$OUT"; exit 0 ;;
  000) rm -f "$OUT"; exit 0 ;;
  *) cat "$OUT" >&2; rm -f "$OUT"; exit 2 ;;
esac
`;
