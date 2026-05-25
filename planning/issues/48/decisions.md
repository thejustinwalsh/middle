# Decisions — Issue #48 (Auto-dispatch + limits)

## slots.ts is the slot authority; the guard is consumed at the enqueue paths
**File(s):** `packages/dispatcher/src/slots.ts`
**Date:** 2026-05-24

**Decision:** Build `slots.ts` as the single slot authority — `getSlotState` derives the three dimensions (per-adapter, per-repo, global) from live `workflows` rows + merged config; `hasFreeSlot` is the enqueue guard; `reserveSlot` is the loop's local decrement. The guard is *consumed* by the auto-dispatch loop (#50) and manual dispatch (#53); #49 unit-tests the authority + guard directly against a live DB.

**Why:** The existing `countActiveImplementationSlots` already counts non-terminal implementation rows (recommender excluded) per-repo and globally — `slots.ts` builds the limit/availability layer on top rather than re-counting. Keeping the guard a pure function of `(SlotState, adapter)` makes the at-capacity / free-slot / per-adapter-vs-global cases unit-testable without the engine, and lets both the loop and manual dispatch share one consultation. I deliberately did **not** overload the daemon's `startDispatch` `string | null` return (whose `null` means the 409 collision reservation) with a slots-full signal — conflating "already running" with "queue full" would mislead `mm dispatch`. Slot refusal is wired where it's naturally testable: the loop skips, manual dispatch reports slots-full.

**Evidence:** `countActiveImplementationSlots` (`workflow-record.ts`) + the recommender's `buildRecommenderContext` already model used-slot derivation; the auto-dispatch pseudocode (spec → "Auto-dispatch loop") consumes `slots.globalAvailable` / `slots.byAdapter[adapter]`.

## Four auto-dispatch triggers behind one debounced scheduler
**File(s):** `packages/dispatcher/src/main.ts`, `hook-server.ts`, `rate-limits.ts`
**Date:** 2026-05-24

**Decision:** The four trigger events all funnel into one `scheduleAutoDispatch(repo)` (250ms debounce + per-repo re-entrancy guard) → `runAutoDispatch(repo)`. Wirings: terminal-state transition (the existing `broadcastWorkflow`, gated on slot-freeing states), rate-limit change (a new module-level `setRateLimitObserver` in `rate-limits.ts`, fanned out to every known repo since rate-limit state is cross-repo by adapter), recommender-run completion (threaded `triggerAutoDispatch` through `dispatchRecommender` → the recommender workflow's existing seam), and manual `mm dispatch` (a new optional `ControlPlane.afterDispatch` the route fires).

**Why:** A debounced scheduler stops a burst of terminal transitions from launching N overlapping passes, and the re-entrancy guard + rerun flag means a trigger arriving mid-pass coalesces into exactly one follow-up. Crucially, the loop's own `enqueue` calls the daemon's `startDispatchImpl` **directly**, not the HTTP route — so the loop never fires `afterDispatch` and can't recursively re-trigger itself. `afterDispatch` only fires for genuine external/route dispatches. I extracted `startDispatchImpl` from the inline `ControlPlane.startDispatch` so the route and the loop share one collision-guarded enqueue.

**Evidence:** Mirrors the existing `setUpdateWorkflowObserver` pattern (process-scoped observer, reset to null on shutdown). The recommender workflow already had a tested `triggerAutoDispatch` step gated on `config.autoDispatch` + a clean parse (`recommender-workflow.test.ts`).

## `mm pause` keys by the git-remote slug; `mm config` is a scoped TOML edit
**File(s):** `packages/cli/src/commands/pause.ts`, `config.ts`, `packages/dispatcher/src/repo-config.ts`
**Date:** 2026-05-24

**Decision:** `mm pause`/`mm resume` write `repo_config.paused_until` keyed by the **git-remote-derived** `owner/name` slug (shared `deriveRepoSlug` in `paths.ts`), because that's the exact key the auto-dispatch loop reads (`row.repo` at dispatch, the recommender's `repoSlug`). A pause with no duration is indefinite (`Number.MAX_SAFE_INTEGER`); `isPaused` honors the timestamp so a future-dated pause auto-expires. `mm config` is a formatting-preserving, section-scoped TOML line edit restricted to a known-keys table (v1: `auto_dispatch`), rejecting unknown keys.

**Why:** Keying pause by anything other than the loop's slug would write a row the loop never reads — a silent no-op. Deriving the slug identically everywhere is the invariant. For `mm config`, a smol-toml round-trip would clobber operator comments/layout, so I edit the target line in place within its `[section]` and leave everything else byte-identical. Restricting to a known-keys table keeps a generic `<key> <value>` surface from silently writing typo'd or unsupported keys; the table is the extension point as more keys become settable.

**Evidence:** `dispatch.ts` and `recommender-run.ts` both derive the slug from the `origin` remote — `paths.ts` now hosts the shared helper. The `[recommender] auto_dispatch` default-false toggle already existed in `config.ts` (`mapRecommender`); the loop's `isAutoDispatchEnabled` now composes it with `!isPaused`.
