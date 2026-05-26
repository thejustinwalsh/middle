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

/**
 * A permission/approval request — the message or the on-screen dialog asks to run
 * something. The `allow … to` arm is bounded (`\S+(?:\s+\S+){0,8}?`, not `.+`)
 * deliberately: this runs on the untrusted, persisted Notification `message`, and
 * a `.+` between whitespace anchors backtracks catastrophically on a long
 * whitespace-laden input (a single-threaded daemon-wide stall). Keep it bounded.
 */
const PERMISSION_MESSAGE_RE =
  /needs?\s+(?:your\s+)?permission|permission\s+to\s+(?:use|run)|requires?\s+(?:your\s+)?approval|wants?\s+to\s+(?:use|run)|allow\s+\S+(?:\s+\S+){0,8}?\s+to\b/i;

/** A Claude permission dialog as it renders in the pane (the boxed yes/no prompt). */
const PERMISSION_PANE_RE =
  /\bdo\s+you\s+want\s+to\s+(?:proceed|allow)\b|❯\s*\d+\.\s*(?:yes|allow)/i;

/** An explicit "waiting for human input" notification — a genuine question. */
const INPUT_MESSAGE_RE =
  /waiting\s+for\s+(?:your\s+)?input|is\s+waiting\s+for\s+(?:you|input)|needs?\s+(?:your\s+)?input|awaiting\s+(?:your\s+)?input/i;

/** Max bytes of `message`/`pane` matched — the signal is always near the top. */
const CLASSIFY_INPUT_MAX = 4096;

/**
 * Classify the notification from its `message` (the Claude Notification payload's
 * field) and the captured pane text. Permission outranks input: a pane showing an
 * approval dialog is a permission block even if the message reads generically.
 * Anything unrecognized is `idle-unknown` — still a block, just unattributed.
 *
 * Inputs are clipped before matching: both come from untrusted sources (a hook
 * payload, a raw pane capture), and the relevant signal is always near the top —
 * a defense-in-depth bound on regex work no matter how the patterns evolve.
 */
export function classifyNotification(opts: { message: string; pane: string }): NotificationKind {
  const message = (opts.message ?? "").slice(0, CLASSIFY_INPUT_MAX);
  const pane = (opts.pane ?? "").slice(0, CLASSIFY_INPUT_MAX);
  if (PERMISSION_MESSAGE_RE.test(message) || PERMISSION_PANE_RE.test(pane)) return "permission";
  if (INPUT_MESSAGE_RE.test(message)) return "input";
  return "idle-unknown";
}
