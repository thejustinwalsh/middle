import type { ParsedState } from "@middle/state-issue";
import { hasFreeSlot, reserveSlot, type SlotState } from "./slots.ts";

/**
 * The auto-dispatch loop (build spec → "Auto-dispatch loop"). Reads the repo's
 * ranked state issue and enqueues every ready Epic that has a free slot, skipping
 * rate-limited adapters and exhausted per-adapter slots and stopping when the
 * repo or global total is full. It decrements a *local* {@link SlotState} as it
 * enqueues so each subsequent row sees fresh headroom without a db round-trip.
 *
 * There is **no pre-dispatch complexity gate** — complexity is the branching
 * factor of a runtime design decision, discovered while the agent works (see
 * "Complexity and architectural forks"); a ready Epic dispatches regardless of
 * any per-sub-issue complexity, and an overrun pauses *that sub-issue* later (#52).
 *
 * Triggered (by the daemon) after: a recommender run completes, any workflow
 * terminal-state transition, any rate-limit state change, and a manual
 * `mm dispatch`. The loop body is the same for every trigger; the deps are
 * injected so it runs without the engine or `gh`.
 */
export type AutoDispatchDeps = {
  /** The `owner/name` slug whose ready work is dispatched. */
  repo: string;
  /**
   * Whether auto-dispatch is enabled for this repo right now — the `[recommender]
   * auto_dispatch` toggle AND the pause state (#51). A disabled repo is a no-op.
   */
  isAutoDispatchEnabled: () => boolean | Promise<boolean>;
  /** Read + parse the repo's state issue (the ranked `readyToDispatch` plan). */
  readState: () => Promise<ParsedState>;
  /** The set of adapter names currently RATE_LIMITED (reset time still in the future). */
  rateLimitedAdapters: () => Set<string> | Promise<Set<string>>;
  /** Snapshot the live slot state once at the start of the pass. */
  getSlotState: () => SlotState;
  /**
   * Enqueue one implementation workflow. Returns the workflow id, or `null` if
   * the enqueue was refused (e.g. the Epic already has an active workflow — the
   * collision guard). A refused enqueue must NOT consume a local slot.
   */
  enqueue: (input: { repo: string; epicNumber: number; adapter: string }) => Promise<string | null>;
};

/** What an auto-dispatch pass enqueued, and why it stopped. */
export type AutoDispatchResult = {
  /** The Epics enqueued this pass, in dispatch order. */
  enqueued: { epicNumber: number; adapter: string }[];
  /**
   * - `disabled` — the repo's auto-dispatch is off (or paused); nothing was read.
   * - `slots-exhausted` — the loop stopped because the repo or global total filled.
   * - `drained` — every ready row was walked (whatever got enqueued).
   */
  reason: "disabled" | "slots-exhausted" | "drained";
};

/** Extract the leading `#<n>` Epic number from a Ready row's `epic` cell, or null. */
function parseEpicNumber(epic: string): number | null {
  const match = /^#(\d+)\b/.exec(epic.trim());
  return match ? Number(match[1]) : null;
}

/** Run one auto-dispatch pass for a repo. See {@link AutoDispatchDeps}. */
export async function autoDispatch(deps: AutoDispatchDeps): Promise<AutoDispatchResult> {
  if (!(await deps.isAutoDispatchEnabled())) return { enqueued: [], reason: "disabled" };

  const state = await deps.readState();
  const rateLimited = await deps.rateLimitedAdapters();
  let slots = deps.getSlotState();
  const enqueued: AutoDispatchResult["enqueued"] = [];

  for (const row of state.readyToDispatch) {
    const epicNumber = parseEpicNumber(row.epic);
    if (epicNumber === null) continue; // a malformed / empty-state cell — never dispatch it
    // Repo or global full → no further row (for any adapter) can dispatch; stop.
    if (slots.global.available <= 0 || slots.repo.available <= 0) {
      return { enqueued, reason: "slots-exhausted" };
    }
    // This row's adapter is blocked, but a later row's adapter may not be.
    if (rateLimited.has(row.adapter)) continue;
    if (!hasFreeSlot(slots, row.adapter)) continue; // adapter cap exhausted (repo/global checked)

    const workflowId = await deps.enqueue({ repo: deps.repo, epicNumber, adapter: row.adapter });
    if (workflowId === null) continue; // refused (collision) → don't charge a local slot
    enqueued.push({ epicNumber, adapter: row.adapter });
    slots = reserveSlot(slots, row.adapter); // local decrement so the next row sees fresh headroom
  }

  return { enqueued, reason: "drained" };
}
