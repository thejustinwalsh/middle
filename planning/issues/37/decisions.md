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

## Unknown gate keys are rejected
**File(s):** `packages/dispatcher/src/gates/verify-config.ts:validateGate`
**Date:** 2026-05-24

**Decision:** A `[[gate]]` carrying a key outside {name, command, timeout_seconds, phases} is a hard error.
**Why:** The schema is tiny; the common failure is a typo (`comand =`) that would otherwise silently drop a gate's command and run zero verification. "Fails loudly" (the #38 acceptance) is worth more than forward-compat leniency for a 4-key schema.

