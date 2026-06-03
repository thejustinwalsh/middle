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
   * collision guard). A refused enqueue must NOT consume a local slot. `epicRef`
   * is the dispatch unit: a numeric Epic number (github mode) or a file-mode slug.
   */
  enqueue: (input: { repo: string; epicRef: string; adapter: string }) => Promise<string | null>;
};

/** What an auto-dispatch pass enqueued, and why it stopped. */
export type AutoDispatchResult = {
  /** The Epics enqueued this pass, in dispatch order (`epicRef`: number or slug). */
  enqueued: { epicRef: string; adapter: string }[];
  /**
   * - `disabled` — the repo's auto-dispatch is off (or paused); nothing was read.
   * - `slots-exhausted` — the loop stopped because the repo or global total filled.
   * - `drained` — every ready row was walked (whatever got enqueued).
   */
  reason: "disabled" | "slots-exhausted" | "drained";
};

/**
 * Whether an auto-dispatch pass actually read + parsed the state issue. A
 * `"disabled"` pass returns *before* {@link AutoDispatchDeps.readState} (the
 * result type's own contract — "nothing was read"); every other reason runs only
 * after a successful read. Callers re-arm parse-failure surfacing
 * ({@link ParseFailureSurfacer.reset}) iff this is true — re-arming without an
 * intervening healthy read would let an unfixed parse failure re-surface a
 * duplicate comment (#180). Any future no-read reason must be excluded here.
 */
export function didReadState(result: AutoDispatchResult): boolean {
  return result.reason !== "disabled";
}

/**
 * Extract the leading `#<ref>` Epic reference from a Ready row's `epic` cell, or
 * null. `<ref>` is `[\w-]+`: a numeric Epic number in github mode (`#42`) or a
 * file-mode Epic slug (`#rollout-epic-store`). The dispatch path is ref-agnostic
 * — `startDispatchImpl` already takes an `epicRef` string (#200).
 */
function parseEpicRef(epic: string): string | null {
  const match = /^#([\w-]+)\b/.exec(epic.trim());
  return match ? match[1]! : null;
}

/**
 * Surfaces a state-issue **parse failure** that halts auto-dispatch onto the
 * state issue itself, deduped per repo. The read-only auto-dispatch loop throws
 * `… does not parse …` when the recommender (or a stray edit) leaves a malformed
 * body — historically that died in stderr only, silently stalling the auto-loop
 * (#180). This announces it once per distinct message (a debounce burst is one
 * comment), and {@link ParseFailureSurfacer.reset}s after a healthy read so a
 * recurrence re-announces.
 */
export type ParseFailureSurfacer = {
  /**
   * If `error` is a "does not parse" failure, surface it on the state issue —
   * unless the identical message was already surfaced for this repo since the
   * last {@link ParseFailureSurfacer.reset}. Returns whether it surfaced.
   * Non-parse errors are ignored (returns false) so transient `gh`/network
   * errors never spam comments.
   */
  surface(repo: string, stateIssue: number, error: Error): Promise<boolean>;
  /** Forget a repo's last-surfaced message after a healthy read, so the next
   *  failure (even an identical one) surfaces again. */
  reset(repo: string): void;
};

/** Build a {@link ParseFailureSurfacer} over a `surfaceProblem` sink (prod: a
 *  `gh` comment). The dedup memory is the closure's `Map`, daemon-lifetime. */
export function createParseFailureSurfacer(
  surfaceProblem: (opts: { repo: string; stateIssue: number; problem: string }) => Promise<void>,
): ParseFailureSurfacer {
  const lastSurfaced = new Map<string, string>();
  return {
    async surface(repo, stateIssue, error) {
      if (!error.message.includes("does not parse")) return false;
      const problem = `⚠️ auto-dispatch halted: state issue #${stateIssue} does not parse, so the ranked dispatch plan can't be read and no Epics will dispatch until this is fixed.\n\n\`${error.message}\``;
      if (lastSurfaced.get(repo) === problem) return false;
      // Record only AFTER a successful comment — a failed `gh` comment (throws)
      // must be retried next tick, not silently suppressed by a recorded dedup.
      await surfaceProblem({ repo, stateIssue, problem });
      lastSurfaced.set(repo, problem);
      return true;
    },
    reset(repo) {
      lastSurfaced.delete(repo);
    },
  };
}

/** Run one auto-dispatch pass for a repo. See {@link AutoDispatchDeps}. */
export async function autoDispatch(deps: AutoDispatchDeps): Promise<AutoDispatchResult> {
  if (!(await deps.isAutoDispatchEnabled())) return { enqueued: [], reason: "disabled" };

  const state = await deps.readState();
  const rateLimited = await deps.rateLimitedAdapters();
  let slots = deps.getSlotState();
  const enqueued: AutoDispatchResult["enqueued"] = [];

  for (const row of state.readyToDispatch) {
    const epicRef = parseEpicRef(row.epic);
    if (epicRef === null) continue; // a malformed / empty-state cell — never dispatch it
    // Repo or global full → no further row (for any adapter) can dispatch; stop.
    if (slots.global.available <= 0 || slots.repo.available <= 0) {
      return { enqueued, reason: "slots-exhausted" };
    }
    // This row's adapter is blocked, but a later row's adapter may not be.
    if (rateLimited.has(row.adapter)) continue;
    if (!hasFreeSlot(slots, row.adapter)) continue; // adapter cap exhausted (repo/global checked)

    const workflowId = await deps.enqueue({ repo: deps.repo, epicRef, adapter: row.adapter });
    if (workflowId === null) continue; // refused (collision) → don't charge a local slot
    enqueued.push({ epicRef, adapter: row.adapter });
    slots = reserveSlot(slots, row.adapter); // local decrement so the next row sees fresh headroom
  }

  return { enqueued, reason: "drained" };
}
