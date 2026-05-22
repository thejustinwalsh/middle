/**
 * Composable tmux TUI driving — `capturePane`, `sendText`, `sendKeys`, and the
 * load-bearing primitive `pollPaneFor`. Adapters use these to dismiss boot
 * prompts, detect login-required screens, wait for ready states, and any other
 * "watch the pane, react to it" flow. The dispatcher's `tmux.ts` keeps the
 * session-lifecycle ops (new/has/kill/status) on top of these.
 */

type TmuxResult = { stdout: string; stderr: string; exitCode: number };

async function runTmux(args: string[]): Promise<TmuxResult> {
  const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exitCode: await proc.exited };
}

/**
 * Capture the visible contents of a tmux pane. Returns null if the session is
 * gone or tmux isn't available — callers treat null as "give up", not "throw".
 */
export async function capturePane(sessionName: string): Promise<string | null> {
  try {
    const result = await runTmux(["capture-pane", "-p", "-t", sessionName]);
    return result.exitCode === 0 ? result.stdout : null;
  } catch {
    return null;
  }
}

/** Send literal text (`send-keys -l`) so the content is never interpreted as key names. */
export async function sendText(sessionName: string, text: string): Promise<void> {
  await runTmux(["send-keys", "-t", sessionName, "-l", text]);
}

export type SendKeysOpts = {
  /**
   * Delay between successive keys, in ms. Default 0 — all keys in one
   * `send-keys` call. Use a non-zero value (50-200ms) when the target TUI
   * needs time to update its menu/selection between keys.
   */
  delayBetweenMs?: number;
};

/**
 * Send a sequence of tmux key names (e.g. ["Down", "Enter"], ["S-Tab"]).
 * `delayBetweenMs` separates the keys into individual `send-keys` calls with
 * a sleep between them — necessary when a single combined call races the
 * receiving TUI's input handler.
 */
export async function sendKeys(
  sessionName: string,
  keys: string[],
  opts: SendKeysOpts = {},
): Promise<void> {
  if (keys.length === 0) return;
  const delay = opts.delayBetweenMs ?? 0;
  if (delay <= 0) {
    await runTmux(["send-keys", "-t", sessionName, ...keys]);
    return;
  }
  for (let i = 0; i < keys.length; i++) {
    await runTmux(["send-keys", "-t", sessionName, keys[i]!]);
    if (i < keys.length - 1) await Bun.sleep(delay);
  }
}

export type PollPaneOpts = {
  /** Hard cap on the polling window, in ms. */
  timeoutMs: number;
  /** Interval between successive captures, ms. Default 200. */
  pollIntervalMs?: number;
  /** When set, writes one `[<tag>]` stderr line per iteration for diagnostics. */
  tag?: string;
};

/**
 * Poll `tmux capture-pane` until `predicate` returns a non-null value, or
 * timeout. Returns the predicate's value on match, null on timeout or session
 * loss. Optional `tag` enables per-iteration diagnostic logging to stderr
 * (paneLen, match boolean, tail preview).
 */
export async function pollPaneFor<T>(
  sessionName: string,
  predicate: (paneContent: string) => T | null,
  opts: PollPaneOpts,
): Promise<T | null> {
  const interval = opts.pollIntervalMs ?? 200;
  const deadline = Date.now() + opts.timeoutMs;
  const tag = opts.tag;
  let iter = 0;
  while (Date.now() < deadline) {
    iter++;
    const pane = await capturePane(sessionName);
    if (pane === null) {
      if (tag) console.error(`[${tag}] pollPaneFor iter ${iter}: capture-pane failed`);
      return null;
    }
    const result = predicate(pane);
    if (tag) {
      const preview = pane.replace(/\s+/g, " ").trim().slice(-200);
      console.error(
        `[${tag}] pollPaneFor iter ${iter}: paneLen=${pane.length} match=${result !== null} tail="${preview}"`,
      );
    }
    if (result !== null) return result;
    await Bun.sleep(interval);
  }
  if (tag) console.error(`[${tag}] pollPaneFor: timed out after ${opts.timeoutMs}ms`);
  return null;
}
