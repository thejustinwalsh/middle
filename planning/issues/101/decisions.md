# Decisions — Issue #101

## Trigger mechanism: a new poller pass, not a Stop hook
**File(s):** `packages/dispatcher/src/gates/checkbox-revert-pass.ts`, `poller-cron.ts`
**Date:** 2026-05-26

**Decision:** Invoke `reconcileCheckboxes` from a new pass on the GitHub poller
cron, over `running` implementation workflows, head-SHA-gated.
**Why:** The issue offered "extension of the GitHub poller … or a Stop-hook-driven
pass — keyed on the Epic PR's head SHA advancing." The codebase decides it:
(1) the reconciler is GitHub-state-driven (reads/writes the PR body), which is the
poller's domain — `reconcileMergedParks` is the existing precedent for "a second
reconcile pass over a different workflow set on the same cron"; (2) the package
CLAUDE.md states the hook server "doesn't invoke business logic on hook receipt —
it just persists and delivers"; running gates (tens of seconds of lint/test)
synchronously inside a hook HTTP handler would block the response and break that
invariant; (3) "keyed on head SHA advancing" is a *polling* comparison across
ticks, not an event reaction. So conventions pick the poller — no architectural
fork needed.
**Evidence:** package `CLAUDE.md` (hook server / watchdog sections); `poller.ts`
`reconcileMergedParks`; `verify.ts` `makeRunPhaseGates` was built for exactly this
seam but had no production consumer.

## Keep the new pass out of `poller.ts`
**File(s):** `packages/dispatcher/src/gates/checkbox-revert-pass.ts`
**Date:** 2026-05-26

**Decision:** The pass lives in its own module under `gates/`, taking the
write-capable `GitHubGateway`; `poller.ts` is untouched.
**Why:** `poller.ts` documents and upholds "Read-only: the poller never writes to
GitHub." This pass writes (reverts the PR body, posts a comment). Putting it in
`poller.ts` would falsify that invariant. It still runs on the poller *cron*
(`poller-cron.ts`), where the read-only constraint doesn't apply.
**Evidence:** `poller-gateway.ts` header comment; `GitHubGateway` (write surface)
vs `GitHubPollGateway` (read-only) split.

## Persist `{ headSha, checkboxState }` in `meta_json`, not new columns
**File(s):** `packages/dispatcher/src/workflow-record.ts`
**Date:** 2026-05-26

**Decision:** Store the per-pass checkbox state + last-seen head SHA in the
existing `meta_json` column via typed merge accessors (`readWorkflowMeta` /
`patchWorkflowMeta`), reusing the column's "adapter-specific scratch" intent.
**Why:** No migration needed; `source` already lives in `meta_json` as precedent.
Merge-on-write (not overwrite) preserves `source`. The reconcile pass is the only
writer of the `checkboxReconcile` key and runs serially on a single-worker cron,
so read-merge-write is race-free here.
**Evidence:** `001_initial.sql` (`meta_json TEXT -- adapter-specific scratch`);
existing `getWorkflowSource` reads `meta_json.source`.

## Head-SHA gate skips the work, not the fetch
**File(s):** `packages/dispatcher/src/gates/checkbox-revert-pass.ts`
**Date:** 2026-05-26

**Decision:** Each pass fetches the Epic PR (`findEpicPr` → body + headSha) and
skips parse/diff/gate-run when `headSha` equals the persisted one.
**Why:** The SHA must be fetched to be compared, so the gate saves the *expensive*
work (running lint/typecheck/test, parsing, body writes), not the one cheap
read. When the gateway can't supply a SHA (`undefined`), fall through and let the
reconciler's own checkbox-state diff provide idempotence.
**Evidence:** `reconcileCheckboxes` only acts on fresh `[ ] → [x]` transitions
(its `getPreviousState` diff), so a fall-through pass is still safe.

## No verify.toml → skip the workflow (nothing to enforce)
**File(s):** `packages/dispatcher/src/gates/checkbox-revert-pass.ts`
**Date:** 2026-05-26

**Decision:** If the worktree has no usable `verify.toml`, skip reconcile for that
workflow (don't revert, don't persist).
**Why:** With no gates declared, a ticked box can never fail a gate, so there is
nothing to revert — tracking state would be dead work. Mirrors verify-on-stop's
"missing/malformed verify.toml → skip (ok)" in `build-deps.ts`.
**Evidence:** `build-deps.ts` `runVerifyGates` skip-on-missing-config behavior.

## `patchWorkflowMeta` must not bump `updated_at`
**File(s):** `packages/dispatcher/src/workflow-record.ts`
**Date:** 2026-05-26

**Decision:** `patchWorkflowMeta` writes only `meta_json`, never `updated_at`.
**Why:** Caught in internal review. The watchdog folds `updated_at` into its
idle-freshness baseline (`watchdog.ts` — `Math.max(last_heartbeat, transcriptMs,
updated_at)`). Both the watchdog and the checkbox-revert pass run over the same
`state = 'running'` set. Had the poller's `setCheckboxReconcileState` bumped
`updated_at`, it would reset a running agent's idle-timeout clock — masking a
genuinely wedged agent (notably on first observation after a daemon restart).
`meta_json` is scratch, not an activity signal. (Bonus: it's also safer for the
dashboard's terminal-run duration calc, which reads `updated_at` for terminal
rows.)
**Evidence:** `watchdog.ts:206`; `packages/dashboard/src/db-deps.ts` duration calc.

## Review round 1 (PR #156): poller cadence is doc-drift, not a code bug
**File(s):** `packages/dispatcher/src/main.ts:600`, `packages/dispatcher/CLAUDE.md`
**Date:** 2026-05-26

**Decision:** CodeRabbit flagged the `main.ts` `startPoller` call as inheriting a
default and asked to pin `intervalMs: 60_000` per a guideline citing
`POLLER_INTERVAL_MS = 60_000`. Declined the bump; fixed the stale docs instead.
**Why:** The guideline (the dispatcher CLAUDE.md) was itself stale. Commit
`8db12e8` deliberately tuned the poller 60s→120s for real-world rate-limit safety
(one `gh` call per parked workflow per tick, no backoff yet — #122) and made the
interval injectable. The 120s default *is* the intended production cadence;
bumping main.ts to 60s would undo that fix and walk the deployment back toward the
5000/hr ceiling. The watchdog (30s) is likewise a constant inherited via
`startWatchdog`, not pinned at the call site — so pinning only the poller would be
inconsistent. Real defect: CLAUDE.md said `60_000` and main.ts's comment said
"every 60s". Corrected both to 120s with the rationale + commit ref.
**Evidence:** `8db12e8` ("tune recommender + poller timing defaults for real-world
use"); `poller-cron.ts:16` (`POLLER_INTERVAL_MS = 120_000`); `watchdog-cron.ts:5`
(`WATCHDOG_INTERVAL_MS = 30_000`, not injectable).

## Review round 1 (PR #156): sanitize the nested `checkboxReconcile` read
**File(s):** `packages/dispatcher/src/workflow-record.ts` (`getCheckboxReconcileState`)
**Date:** 2026-05-26

**Decision:** `getCheckboxReconcileState` now sanitizes `meta_json.checkboxReconcile`
back to its `CheckboxReconcileState` contract instead of trusting the nested shape
(non-object/array → default; non-string `headSha` → null; `state` rebuilt keeping
only boolean-valued entries).
**Why:** `readWorkflowMeta` only guards the *top-level* JSON shape, so the nested
value could still violate the declared return type at runtime (version skew, a
hand-edited row). This matches the validate-don't-trust posture the sibling
`getWorkflowSource` already used — resolving the class (untrusted nested reads),
not just the one line. A clean-eyes pass confirmed prototype-pollution is a
non-issue here (`Object.fromEntries` writes own properties; the only consumer
indexes by parsed sub-issue number) and that the two accessors are now the
complete set of nested-meta readers.
**Evidence:** `getWorkflowSource` (same file) prior art; `checkbox-revert.ts:145`
consumer indexes `previous[box.subIssue]` by number.
