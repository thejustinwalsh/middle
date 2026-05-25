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
 * it and feeds stderr back to the agent as the reason. The ONLY thing that blocks
 * is the dispatcher's explicit DENY verdict:
 *   - HTTP 403 → DENY → reason (response body) to stderr, exit 2 (blocks).
 *   - Everything else → allow → exit 0. That deliberately includes 200 (gate
 *     passed), **404 (no gate wired on this session's server** — the recommender
 *     and docs runs construct their hook server without the PR-ready gate, so the
 *     route 404s), 000 (unreachable dispatcher), and 5xx (dispatcher hiccup).
 * Treating only a reachable 403 as a deny is what stops the gate from wedging an
 * agent that has no gate to satisfy: a 404 here used to hit the catch-all deny
 * branch and block EVERY Bash call in a recommender session. The dispatcher does
 * the command matching, so a non-`gh pr ready` Bash call is allowed cheaply.
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
  --data-binary @- --max-time 15 || true)
# curl can exit before emitting %{http_code} (DNS/connect failure, timeout),
# leaving CODE empty; normalize to 000 so the unreachable case is explicit (it
# allows either way — only an explicit 403 below blocks).
[ -n "$CODE" ] || CODE="000"
case "$CODE" in
  403) cat "$OUT" >&2; rm -f "$OUT"; exit 2 ;;
  *) rm -f "$OUT"; exit 0 ;;
esac
`;
