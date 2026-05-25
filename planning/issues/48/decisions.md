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

## A complexity pause is a tagged `asked-question`, surfaced via an Epic comment
**File(s):** `packages/core/src/adapter.ts`, `packages/adapters/claude/src/classify.ts`, `packages/dispatcher/src/workflows/implementation.ts`, `build-deps.ts`
**Date:** 2026-05-24

**Decision:** A complexity pause reuses the existing `asked-question` park spine (which already routes to `waiting-human`), distinguished by a `kind: "complexity"` field on the `.middle/blocked.json` `BlockedSentinel`. The dispatch brief instructs the agent to set that field for a complexity overrun (and carries the repo's `complexity_ceiling` as the fork budget). On park, the workflow passes the pause kind to `postQuestion`; the default `gh`-backed poster comments on the Epic with the literal **complexity pause** framing. The recommender (which owns "Needs human input") reads that comment and classifies the Epic under the `complexity pause` label on its next run.

**Why:** The dispatcher does not own the state issue's "Needs human input" section (owners line: `dispatcher=in-flight,rate-limits,slot-usage`), so it cannot write the label directly — and the recommender would overwrite it anyway. The honest surfacing path is a GitHub artifact the recommender keys off, exactly mirroring how an ambiguity question is surfaced. Reusing the `asked-question` spine (rather than a new park kind) means the waitFor/resume plumbing (Phase 5) needs no change — a complexity pause resumes the same way once the human clarifies or applies `approved`. `complexity_ceiling` is resolved per-repo at dispatch time (the deps are shared across repos), defaulting to 3. The brief is the delivery mechanism for the `kind` contract, so the agent-side skill needs no edit (out of scope for #52).

**Evidence:** The recommender skill already lists "An agent paused a sub-issue on a `complexity pause`" as a `needs-human` case and the schema doc already defines the `complexity pause` label. There is no pre-dispatch ceiling gate in `auto-dispatch.ts` — the loop's only gates are slots + rate limits (pinned by a test).

## `approved` is a GitHub label read into the brief; manual dispatch gets a route-level slot gate
**File(s):** `packages/dispatcher/src/build-deps.ts`, `github.ts`, `hook-server.ts`, `main.ts`, `workflow-record.ts`
**Date:** 2026-05-24

**Decision:** The `approved` signal is delivered to the agent via the dispatch brief (built in #52's `defaultDispatchBrief`): the default `isEpicApproved` reads the Epic's labels (`gh issue view --json labels`) and, when `approved` is present, the brief authorizes a best-judgment call past a complexity overrun instead of pausing. Manual `mm dispatch` slot-limiting is a **route-level** gate: `ControlPlane.slotAvailable(repo, adapter)` (implemented in `main.ts` via `getSlotState` + `hasFreeSlot`) is consulted by the `/control/dispatch` handler, returning **429** when full. Dispatch origin is recorded as `meta_json.source` (`"manual"` for a route dispatch, `"auto"` for a loop enqueue), threaded through `ImplementationInput` → `createWorkflowRecord` and carried forward by continuations.

**Why:** Delivering `approved` through the brief (not a separate channel) keeps it alongside `complexity_ceiling` — one place the agent reads its fork policy. The slot gate is route-level rather than inside `startDispatchImpl` because the auto-dispatch loop already does its own local slot accounting and enqueues through `startDispatchImpl` *directly* (bypassing the route); putting the DB-slot check in the shared `startDispatchImpl` would double-gate the loop inconsistently (its rows are created async, so a mid-pass DB read disagrees with the loop's local view). Keeping it on the route means it fires only for genuine manual dispatches. A distinct **429** (vs. the collision **409**) tells `mm dispatch` *why* it was refused — "queue full", not "already running".

**Evidence:** `getSlotState`/`hasFreeSlot` (#49) are the slot authority; the loop (#50) reserves a local view; the schema's `meta_json` column is the documented adapter-scratch field. The brief's approved/not-approved framing landed in #52's `defaultDispatchBrief`.
