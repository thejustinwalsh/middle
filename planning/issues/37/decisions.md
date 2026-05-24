# Issue #37 — Decisions log

## `verify.toml` location follows the `.middle/config.toml` convention
**File(s):** `packages/dispatcher/src/gates/verify-config.ts`, `schemas/verify.v1.md`
**Date:** 2026-05-24

**Decision:** Per-repo gates live at `<worktree>/.middle/verify.toml`; the committed schema source of truth is `schemas/verify.v1.md`.
**Why:** `.middle/` is gitignored (operational, installed by `mm init`), matching the existing `.middle/config.toml` per-repo config. Keeping `verify.toml` there is consistent with that seam. "Schema defined and documented" is satisfied by the committed `schemas/verify.v1.md`, mirroring `schemas/state-issue.v1.md` — without fighting the `.middle/` gitignore.
**Evidence:** `.gitignore` `.middle/` rule; `packages/core/src/config.ts` per-repo config path `<repo>/.middle/config.toml`.

## Per-phase addressing via an optional `phases` allowlist
**File(s):** `packages/dispatcher/src/gates/verify-config.ts:gatesForPhase`
**Date:** 2026-05-24

**Decision:** A gate with no `phases` key runs for every phase; a gate with `phases = [N, ...]` runs only for those sub-issues. `gatesForPhase(config, N)` resolves the set.
**Why:** The reconciler runs "phase N's gates" keyed by sub-issue number, but a repo author can't know sub-issue numbers in advance — so the default (omit `phases`) makes the full gate set apply to every phase. The allowlist is the escape hatch for a gate that only makes sense on specific phases (e.g. an acceptance script). Rejected: keying gates by ordinal phase index (fragile against sub-issue reordering) and a separate `[phase.N]` table (more schema surface for a rare need).
**Evidence:** `checkbox-revert.ts` `runGates(subIssue)` seam; #38 acceptance "Gates are addressable per phase".

## Gate-runner timeout: SIGKILL the shell + grace-bounded stream drain (no process-group kill)
**File(s):** `packages/dispatcher/src/gates/gate-runner.ts:runGate`
**Date:** 2026-05-24

**Decision:** Run gates as `sh -c <command>`. On timeout, SIGKILL the shell and bound stdout/stderr collection with a 500ms grace race. Don't `exec`-replace and don't process-group-kill.
**Why:** Two alternatives were tried and rejected. (1) `sh -c "exec <command>"` makes a single-command gate the process itself (clean kill) but **changes compound-command semantics** — `exec a; b` execs `a` and never runs `b`; a real gate like `bun run build && bun test` would silently mis-run. A test caught this. (2) Process-group kill (`setsid` + `kill -pid`) terminates grandchildren but `setsid` isn't portable to macOS, which middle targets. The chosen approach preserves shell semantics and stays portable; the cost is a timed-out gate's grandchild is left to exit on its own (rare, reaped by init) — the grace-bounded drain guarantees the runner itself never hangs.
**Evidence:** `gate-runner.test.ts` "exceeds its timeout … returns promptly (<3000ms)"; the failing "exec breaks `;`" test during development.

## Runner does not short-circuit on first failure
**File(s):** `packages/dispatcher/src/gates/gate-runner.ts:runGates`
**Date:** 2026-05-24

**Decision:** `runGates` runs every gate even after one fails; aggregate `ok` is all-pass and `failedGate` names the first failure.
**Why:** The evidence comment (#40) is more useful to a reviewer when it shows the full picture (e.g. typecheck passed, test failed, acceptance passed) rather than stopping at the first red. The first-failure name is still captured for the terse checkbox-revert comment.
**Evidence:** `gate-runner.test.ts` "later gates still run".

## Unknown gate keys are rejected
**File(s):** `packages/dispatcher/src/gates/verify-config.ts:validateGate`
**Date:** 2026-05-24

**Decision:** A `[[gate]]` carrying a key outside {name, command, timeout_seconds, phases} is a hard error.
**Why:** The schema is tiny; the common failure is a typo (`comand =`) that would otherwise silently drop a gate's command and run zero verification. "Fails loudly" (the #38 acceptance) is worth more than forward-compat leniency for a 4-key schema.

