/**
 * Classify a Claude `Notification` hook into the kind of block it represents, so
 * the watchdog's notification failsafe (`reconcileNotifications`) can record what
 * it saw and tailor its reaction. A Notification fires when the agent is waiting
 * on a human — for a permission/approval, or just idle-waiting for input — which
 * for a headless run is a stuck agent. The classification is best-effort
 * (Claude's `message` field is terse); the failsafe's mechanical reaction
 * (capture → nudge → fast-fail) is uniform across kinds, and the kind is what
 * lands in the recorded event + the fail reason. Pure, so it unit-tests without
 * the engine.
 */

/**
 * What an `agent.notification` is waiting on:
 * - `permission` — a tool/command needs approval (e.g. "needs your permission to
 *   use Bash") or the pane shows a permission dialog. The headless run can't grant
 *   it, so the agent must proceed-without or block.
 * - `input` — the agent is explicitly waiting for human input ("waiting for your
 *   input"): a genuine question.
 * - `idle-unknown` — a Notification we can't attribute; treated as a block all the
 *   same (a quiet agent past the grace window is stuck either way).
 */
export type NotificationKind = "permission" | "input" | "idle-unknown";

/** A permission/approval request — the message or the on-screen dialog asks to run something. */
const PERMISSION_MESSAGE_RE =
  /needs?\s+(?:your\s+)?permission|permission\s+to\s+(?:use|run)|requires?\s+(?:your\s+)?approval|wants?\s+to\s+(?:use|run)|allow\s+.+\s+to\b/i;

/** A Claude permission dialog as it renders in the pane (the boxed yes/no prompt). */
const PERMISSION_PANE_RE =
  /\bdo\s+you\s+want\s+to\s+(?:proceed|allow)\b|❯\s*\d+\.\s*(?:yes|allow)/i;

/** An explicit "waiting for human input" notification — a genuine question. */
const INPUT_MESSAGE_RE =
  /waiting\s+for\s+(?:your\s+)?input|is\s+waiting\s+for\s+(?:you|input)|needs?\s+(?:your\s+)?input|awaiting\s+(?:your\s+)?input/i;

/**
 * Classify the notification from its `message` (the Claude Notification payload's
 * field) and the captured pane text. Permission outranks input: a pane showing an
 * approval dialog is a permission block even if the message reads generically.
 * Anything unrecognized is `idle-unknown` — still a block, just unattributed.
 */
export function classifyNotification(opts: { message: string; pane: string }): NotificationKind {
  const message = opts.message ?? "";
  const pane = opts.pane ?? "";
  if (PERMISSION_MESSAGE_RE.test(message) || PERMISSION_PANE_RE.test(pane)) return "permission";
  if (INPUT_MESSAGE_RE.test(message)) return "input";
  return "idle-unknown";
}
