# Decisions — Issue #128 (Notification failsafe)

## Failsafe lives in the watchdog, not the hook server
**File(s):** `packages/dispatcher/src/watchdog.ts`
**Date:** 2026-05-26

**Decision:** React to `agent.notification` as a new watchdog reconcile pass (`reconcileNotifications`), not as an event-driven handler in the hook server.
**Why:** The acceptance criteria are explicit about reacting on "notification **+ subsequent idle**" — a transient notification the agent resolves itself must not trip the failsafe. Distinguishing "the agent went quiet after notifying" from "the agent kept working" is inherently a staleness check, which is the watchdog's whole job. The watchdog already sweeps every `launching`/`running` workflow on a 30s cadence with `tmux` + `db` in hand, regardless of spawn kind — so AC5 ("all spawn kinds") falls out for free, and there's no new scheduling machinery. A hook-server handler would fire instantly on every notification and couldn't tell a transient one from a real block.
**Evidence:** `watchdog.ts` rule 3 (activity freshness) already derives idleness from `max(last_heartbeat, transcriptMs, updated_at)`; the notification rule uses a similar staleness check but on a stricter baseline — `activityMs = max(last_heartbeat, transcriptMs)` (no `updated_at`) — and flags a stall when `notifTs > activityMs`. The stricter baseline keeps heartbeat-bookkeeping writes (`reconcileTranscriptDrift` sets `updated_at = now`) from masking a real notification-idle. See "Anchor idle + 'handled' on real activity, not `updated_at` or `notifTs`" below for the rationale.

## Intervene by instruction-nudge, route a real block into the existing park
**File(s):** `packages/dispatcher/src/watchdog.ts`
**Date:** 2026-05-26

**Decision:** The intervention is a `sendText` + `sendEnter` instruction ("you're headless — proceed, or write `.middle/blocked.json` and stop"), not synthetic keystrokes that approve a permission dialog.
**Why:** Blindly pressing "yes" on a permission dialog is unsafe (it could approve a destructive action) and TUI-fragile (depends on Claude's exact dialog layout/key bindings). The instruction-nudge is the same proven mechanism the bare-stop nudge already uses (`resolveBareStop`). It routes a genuine block into the **existing** asked-question park — the agent writes the sentinel and stops, `classifyStop` sees it → `parkForResume` → posts to the issue — which is exactly the "layers on it / generalizes it, don't re-architect the asked-question park" the issue's out-of-scope note asks for.
**Evidence:** `implementation.ts:resolveBareStop` (sendText "continue" + sendEnter); `classify.ts` asked-question path; issue #128 out-of-scope note.

## Fast-fail is the proven idle-kill path, triggered sooner
**File(s):** `packages/dispatcher/src/watchdog.ts`
**Date:** 2026-05-26

**Decision:** When the nudge doesn't take (still idle past a kill-grace), fast-fail via the existing `failWorkflow` (kill session + state=failed), with reason `notification-block:<kind>` and the captured snapshot recorded.
**Why:** The "never hang headless" guarantee (AC3) needs a terminal backstop. `failWorkflow` is already the proven idle-kill terminus; the notification failsafe just reaches it ~3 min after the notification instead of the 15-min idle ceiling, and only after a nudge gave the agent a chance to recover. Defaults: `notificationGraceMs = 60s` (capture+nudge), `notificationKillGraceMs = 120s` (then fail).
**Evidence:** `watchdog.ts:failWorkflow` / the `idle-timeout` path; `SLOT_FREEING_STATES` in `main.ts` frees the slot on `failed`.

## Failsafe state is derived from events, not new columns
**File(s):** `packages/dispatcher/src/watchdog.ts`, `packages/dispatcher/src/workflow-record.ts`
**Date:** 2026-05-26

**Decision:** Track the per-notification handling ("captured at", "intervened at", kind) via `notification.captured` / `notification.intervened` event rows, compared against the activity baseline (`activityMs = max(last_heartbeat, transcriptMs)`) — no schema change.
**Why:** Mirrors how the watchdog already marks `watchdog.idle` once per idle period via `latestEventType`. Comparing `capturedTs > activityMs` re-arms the failsafe only on genuine resumed activity (not on each repeat "still waiting" notification) — see the "Anchor idle + 'handled' on real activity" decision below for the bugs that the obvious "handled when capturedTs ≥ notifTs" formulation hides. Added `lastEventTs(db, id, type)` to read the latest ts of a given event type (the `firstEventTs` sibling).
**Evidence:** `watchdog.ts` rule 3 idle-once guard; `workflow-record.ts:firstEventTs`.

## Anchor idle + "handled" on real activity, not `updated_at` or `notifTs`
**File(s):** `packages/dispatcher/src/watchdog.ts`
**Date:** 2026-05-26

**Decision:** `activityMs = max(last_heartbeat, transcriptMs)` (no `updated_at`); a stall is "handled" once `capturedTs > activityMs` (not `capturedTs >= notifTs`).
**Why:** Two bugs the obvious formulation hides. (1) `reconcileTranscriptDrift` sets `updated_at = now` on a heartbeat correction — including `updated_at` in the activity baseline would let that bookkeeping write mask a genuine notification-idle. `last_heartbeat`/`transcriptMs` are the real activity signals. (2) Anchoring "handled" on the notification ts means a stuck agent re-emitting the *same* "waiting for input" notification every ~60s re-arms capture forever and the run never fast-fails — the exact "never hang headless" failure this issue exists to kill. Anchoring on activity instead: repeat notifications without real progress keep `handled = true`, so the kill clock runs; only genuine activity (then a fresh stall) re-arms. Each is covered by a regression test (`repeat notification ... does NOT reset the kill clock`, `fresh notification AFTER genuine activity re-arms`).
**Evidence:** `reconcileTranscriptDrift` sets `updated_at = now`; `watchdog.test.ts` notification-failsafe suite.
