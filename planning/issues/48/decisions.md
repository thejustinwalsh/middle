# Decisions — Issue #48 (Auto-dispatch + limits)

## slots.ts is the slot authority; the guard is consumed at the enqueue paths
**File(s):** `packages/dispatcher/src/slots.ts`
**Date:** 2026-05-24

**Decision:** Build `slots.ts` as the single slot authority — `getSlotState` derives the three dimensions (per-adapter, per-repo, global) from live `workflows` rows + merged config; `hasFreeSlot` is the enqueue guard; `reserveSlot` is the loop's local decrement. The guard is *consumed* by the auto-dispatch loop (#50) and manual dispatch (#53); #49 unit-tests the authority + guard directly against a live DB.

**Why:** The existing `countActiveImplementationSlots` already counts non-terminal implementation rows (recommender excluded) per-repo and globally — `slots.ts` builds the limit/availability layer on top rather than re-counting. Keeping the guard a pure function of `(SlotState, adapter)` makes the at-capacity / free-slot / per-adapter-vs-global cases unit-testable without the engine, and lets both the loop and manual dispatch share one consultation. I deliberately did **not** overload the daemon's `startDispatch` `string | null` return (whose `null` means the 409 collision reservation) with a slots-full signal — conflating "already running" with "queue full" would mislead `mm dispatch`. Slot refusal is wired where it's naturally testable: the loop skips, manual dispatch reports slots-full.

**Evidence:** `countActiveImplementationSlots` (`workflow-record.ts`) + the recommender's `buildRecommenderContext` already model used-slot derivation; the auto-dispatch pseudocode (spec → "Auto-dispatch loop") consumes `slots.globalAvailable` / `slots.byAdapter[adapter]`.
