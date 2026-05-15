/**
 * tmux session helpers. tmux is middle's agent supervisor — agents run as
 * interactive sessions inside tmux, driven by `send-keys`. These helpers shell
 * out to the `tmux` binary and surface failures as typed `TmuxError`s rather
 * than silent no-ops. Source of truth: build spec → "Top-level architecture".
 */

export class TmuxError extends Error {
  readonly args: string[];
  readonly exitCode: number;
  readonly stderr: string;

  constructor(args: string[], exitCode: number, stderr: string) {
    super(`tmux ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
    this.name = "TmuxError";
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

type TmuxResult = { stdout: string; stderr: string; exitCode: number };

async function runTmux(args: string[]): Promise<TmuxResult> {
  const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/** Run a tmux command, throwing `TmuxError` on a non-zero exit. */
async function tmux(args: string[]): Promise<string> {
  const result = await runTmux(args);
  if (result.exitCode !== 0) {
    throw new TmuxError(args, result.exitCode, result.stderr);
  }
  return result.stdout;
}

export type NewSessionOpts = {
  sessionName: string;
  /** argv of the interactive command tmux runs inside the session. */
  command: string[];
  /** Working directory for the session. */
  cwd?: string;
  /** Env vars injected at spawn time via `tmux new-session -e KEY=val`. */
  env?: Record<string, string>;
  /** Pane width; a generous fixed default keeps TUI output from wrapping. */
  width?: number;
  /** Pane height. */
  height?: number;
};

const DEFAULT_WIDTH = 220;
const DEFAULT_HEIGHT = 50;

/**
 * Create a detached session running `command` at a generous fixed size.
 * Throws `TmuxError` if the name is already taken.
 */
export async function newSession(opts: NewSessionOpts): Promise<void> {
  const args = [
    "new-session",
    "-d",
    "-s",
    opts.sessionName,
    "-x",
    String(opts.width ?? DEFAULT_WIDTH),
    "-y",
    String(opts.height ?? DEFAULT_HEIGHT),
  ];
  if (opts.cwd) args.push("-c", opts.cwd);
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(...opts.command);
  await tmux(args);
}

/**
 * Send literal text into a session. Uses `send-keys -l` so prompt content is
 * sent verbatim and never interpreted as tmux key names. Does not press Enter.
 */
export async function sendText(sessionName: string, text: string): Promise<void> {
  await tmux(["send-keys", "-t", sessionName, "-l", text]);
}

/** Press Enter in a session — the submit that follows `sendText`. */
export async function sendEnter(sessionName: string): Promise<void> {
  await tmux(["send-keys", "-t", sessionName, "Enter"]);
}

/** Return the visible pane contents — for readiness / echo confirmation. */
export async function capturePane(sessionName: string): Promise<string> {
  return tmux(["capture-pane", "-t", sessionName, "-p"]);
}

/** Whether a named session is currently alive. Never throws on "not found". */
export async function hasSession(sessionName: string): Promise<boolean> {
  const result = await runTmux(["has-session", "-t", sessionName]);
  return result.exitCode === 0;
}

export type SessionStatus = {
  alive: boolean;
  paneCount: number;
};

/** Report liveness and pane count. Returns a not-alive status for an unknown session. */
export async function status(sessionName: string): Promise<SessionStatus> {
  const result = await runTmux(["list-panes", "-t", sessionName, "-F", "#{pane_id}"]);
  if (result.exitCode !== 0) {
    return { alive: false, paneCount: 0 };
  }
  const paneCount = result.stdout.split("\n").filter((line) => line.trim() !== "").length;
  return { alive: paneCount > 0, paneCount };
}

/**
 * Terminate a named session. Idempotent: killing a session that is already gone
 * is a no-op, not a throw. A real failure (a live session that refuses to die)
 * still surfaces as a `TmuxError`.
 */
export async function killSession(sessionName: string): Promise<void> {
  if (!(await hasSession(sessionName))) return;
  await tmux(["kill-session", "-t", sessionName]);
}
