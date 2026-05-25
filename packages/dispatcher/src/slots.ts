import type { Database } from "bun:sqlite";
import { countActiveImplementationSlots } from "./workflow-record.ts";

/**
 * Slot accounting — the concurrency authority the dispatcher's enqueue paths
 * consult. A "slot" is one live interactive session; a session is held for a
 * dispatch's whole non-terminal life (build spec → "Sessions are slot-expensive"),
 * so the used count is exactly the non-terminal `implementation` workflow count
 * ({@link countActiveImplementationSlots}). The recommender runs on its own
 * dedicated slot and is excluded there, so it never counts against these caps.
 *
 * Three dimensions gate every enqueue, all derived from the same live rows:
 * - **per-adapter** (repo-scoped) — `limits.max_concurrent_per_adapter`
 * - **per-repo total** — `limits.max_concurrent`
 * - **global total** (cross-repo, the shared db) — `global.max_concurrent`
 *
 * Source of truth: build spec → "Configuration" (`[limits]`), "Auto-dispatch
 * loop", and "State issue schema" → "Slot usage".
 */

/** The configured concurrency caps, merged global + per-repo. */
export type SlotLimits = {
  /**
   * Per-adapter cap, keyed by adapter name (`limits.max_concurrent_per_adapter`).
   * An adapter absent here has no separate ceiling — it's gated only by the repo
   * and global dimensions.
   */
  perAdapter: Record<string, number>;
  /** Repo-level total cap (`limits.max_concurrent`). */
  repoMax: number;
  /** Global total cap (`global.max_concurrent`) — spans every repo on the shared db. */
  globalMax: number;
};

/** One slot dimension: how many are in use, the cap, and the remaining headroom. */
export type SlotDimension = {
  used: number;
  max: number;
  /** `max - used`, clamped to 0 — a tightened cap never reports negative headroom. */
  available: number;
};

/** A repo's slot picture across all three gating dimensions. */
export type SlotState = {
  /** Per-adapter (repo-scoped) dimensions, keyed by adapter name. */
  byAdapter: Record<string, SlotDimension>;
  /** The repo-total dimension. */
  repo: SlotDimension;
  /** The global (cross-repo) dimension. */
  global: SlotDimension;
};

/** Build a dimension from a used count and cap, clamping availability to ≥ 0. */
function dimension(used: number, max: number): SlotDimension {
  return { used, max, available: Math.max(0, max - used) };
}

/**
 * Derive the live slot state for a repo from the `workflows` table + merged
 * config. Per-repo `used` (drives `byAdapter` + `repo`) is scoped to this repo;
 * `global.used` spans every repo on the shared db — the two are deliberately
 * distinct (a repo's per-repo cap must not be charged for another repo's agents).
 * The recommender's row is excluded by {@link countActiveImplementationSlots}.
 */
export function getSlotState(db: Database, repo: string, limits: SlotLimits): SlotState {
  const repoUsed = countActiveImplementationSlots(db, repo);
  const globalUsed = countActiveImplementationSlots(db).total;
  const byAdapter: Record<string, SlotDimension> = {};
  for (const [adapter, max] of Object.entries(limits.perAdapter)) {
    byAdapter[adapter] = dimension(repoUsed.perAdapter[adapter] ?? 0, max);
  }
  return {
    byAdapter,
    repo: dimension(repoUsed.total, limits.repoMax),
    global: dimension(globalUsed, limits.globalMax),
  };
}

/**
 * Whether an adapter can take a slot right now: the repo and global dimensions
 * must both have headroom, and — if the adapter has a per-adapter cap — that
 * dimension too. The enqueue guard both the auto-dispatch loop and manual
 * dispatch consult; an adapter with no configured per-adapter cap is gated only
 * by repo + global.
 */
export function hasFreeSlot(state: SlotState, adapter: string): boolean {
  if (state.global.available <= 0 || state.repo.available <= 0) return false;
  const adapterDim = state.byAdapter[adapter];
  return adapterDim === undefined || adapterDim.available > 0;
}

/** Charge one slot against a dimension (used +1, available recomputed). */
function charge(dim: SlotDimension): SlotDimension {
  return dimension(dim.used + 1, dim.max);
}

/**
 * Return a new {@link SlotState} with one slot charged to `adapter` — the repo
 * and global dimensions always, plus the adapter's own dimension when it has a
 * cap. Pure (the input is left untouched) so the auto-dispatch loop can decrement
 * a local view as it enqueues each row, the next row seeing fresh headroom without
 * a db round-trip.
 */
export function reserveSlot(state: SlotState, adapter: string): SlotState {
  const adapterDim = state.byAdapter[adapter];
  return {
    byAdapter: adapterDim ? { ...state.byAdapter, [adapter]: charge(adapterDim) } : state.byAdapter,
    repo: charge(state.repo),
    global: charge(state.global),
  };
}
