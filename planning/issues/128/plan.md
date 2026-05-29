# Issue #128: Failsafe — detect + rescue an agent stuck on a Notification (never hang headless)

**Link:** https://github.com/thejustinwalsh/middle/issues/128
**Branch:** middle-issue-128

## Goal

When a headless agent emits Claude's `Notification` hook (it's waiting on a human — a permission, an executability block, or just idle-waiting) and then goes quiet, the dispatcher must **react fast** instead of letting the run burn to the idle-kill ceiling. It captures the agent's state, classifies the notification, nudges the agent to proceed-or-block, and fast-fails with that captured context if the nudge doesn't take — for **all** spawn kinds (implementation, recommender, documentation).

## Approach

- `agent.notification` is already received + persisted by the hook server (with the Claude `message` field in its payload), but nothing acts on it. The failsafe is a new **watchdog reconcile pass** — the watchdog already sweeps every `launching`/`running` workflow on a 30s cadence with `tmux` + `db` in hand, regardless of spawn kind, so it's the natural, kind-agnostic home (AC5 falls out for free).
- React on **notification + subsequent idle** (a grace window), not on every notification — a transient notification the agent resolves itself must not trip the failsafe. "Idle since the notification" = no transcript/heartbeat activity newer than the latest `agent.notification` event.
- The intervention is the **same proven mechanism the bare-stop nudge uses** (`sendText` + `sendEnter`): type an instruction into the session telling the agent it's headless — proceed with the task, or write `.middle/blocked.json` and stop. That routes a genuine block into the **existing** asked-question park (the agent stops with the sentinel → `classifyStop` → `parkForResume` → posts to the issue), satisfying the out-of-scope note ("layers on it / generalizes it — don't re-architect the asked-question park").
- The **fast-fail backstop** is the proven idle-kill path (`failWorkflow`: kill session + state=failed), triggered ~3 min after the notification instead of 15 min, with the captured snapshot + classification recorded on the workflow.

## Phases

1. **Classify** — `notification-classify.ts`: pure `classifyNotification({ message, pane }) → "permission" | "input" | "idle-unknown"` + unit tests.
2. **Reconcile + capture + intervene + fast-fail** — `reconcileNotifications` in `watchdog.ts`: extend `WatchdogTmux` with `capturePane`/`sendText`/`sendEnter`, add the grace thresholds + `notification.captured`/`notification.intervened` events + `notification-block:<kind>` fail reason; `lastEventTs` helper in `workflow-record.ts`. Watchdog tests.
3. **Wire** — pass the new tmux methods in `main.ts`; call `reconcileNotifications` from the watchdog cron. Full typecheck/lint/test.

## Files likely to change

- `packages/dispatcher/src/notification-classify.ts` — new: pure classifier.
- `packages/dispatcher/src/watchdog.ts` — `reconcileNotifications`, `WatchdogTmux` capture/send methods, event constants, grace thresholds.
- `packages/dispatcher/src/workflow-record.ts` — `lastEventTs(db, id, type)` helper.
- `packages/dispatcher/src/watchdog-cron.ts` — call `reconcileNotifications` in the processor.
- `packages/dispatcher/src/main.ts` — wire `capturePane`/`sendText`/`sendEnter` into the watchdog deps.
- `packages/dispatcher/test/notification-classify.test.ts`, `packages/dispatcher/test/watchdog.test.ts` — tests.

## Out of scope

- Re-architecting the existing asked-question park (the failsafe layers on it via the nudge).
- A screenshot capture (the AC makes it optional; the `capture-pane` text snapshot is the "at minimum" it requires).
- Blindly auto-approving a permission dialog with synthetic keystrokes (unsafe + TUI-fragile); the instruction-nudge + fast-fail is the safe interpretation of "auto-resolve where safe, or instruct".

## Open questions

- None blocking. Grace defaults chosen as `notificationGraceMs = 60s`, `notificationKillGraceMs = 120s` (≈3 min to fast-fail vs. the 15 min idle-kill); operator-tunable later if needed.
