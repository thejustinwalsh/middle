import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "@middle/core";
import { defaultPidFile } from "../paths.ts";

export type StartOptions = {
  /** Override the pid-file path (defaults to `~/.middle/dispatcher.pid`). */
  pidFile?: string;
  /** Override the dispatcher entrypoint (defaults to `@middle/dispatcher`'s main). */
  entrypoint?: string;
  /**
   * Open the queue observability page once the dispatcher is up. The flag forces
   * it on; absent, the `[dashboard] windowed` config default decides.
   */
  window?: boolean;
  /** Override the global config path (for the port + `windowed` default). */
  configPath?: string;
  /** Readiness-poll budget before giving up on opening the window (default 10000ms). */
  healthTimeoutMs?: number;
  /** Seam: open a URL in the operator's browser. Defaults to the platform opener. */
  openUrl?: (url: string) => void;
  /** Seam: poll the daemon's `/health` until ready. Injectable for tests. */
  waitForHealth?: (base: string, timeoutMs: number) => Promise<boolean>;
};

const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;
const DEFAULT_DISPATCHER_PORT = 8822;

/** Whether a process with this pid is currently alive. */
function isAlive(pid: number): boolean {
  // Reject pid <= 0: process.kill(0, …) signals the caller's whole process
  // group and negative pids target other groups — never what we mean here.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveDispatcherEntrypoint(): string {
  return Bun.resolveSync("@middle/dispatcher", import.meta.dir);
}

/**
 * `mm start` — spawn the long-running dispatcher process (hook server + bunqueue
 * engine), detached, and record its pid for `mm stop`. A stale pid file (the
 * recorded process is gone) is cleared and a fresh dispatcher is started.
 * Returns a process exit code.
 */
export function runStart(opts: StartOptions = {}): number {
  const pidFile = opts.pidFile ?? defaultPidFile();

  if (existsSync(pidFile)) {
    const existing = Number(readFileSync(pidFile, "utf8").trim());
    if (Number.isInteger(existing) && isAlive(existing)) {
      console.error(`mm start: dispatcher already running (pid ${existing})`);
      return 1;
    }
    rmSync(pidFile, { force: true }); // stale — the recorded process is gone
  }

  const entrypoint = opts.entrypoint ?? resolveDispatcherEntrypoint();
  const proc = Bun.spawn(["bun", entrypoint], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });

  // Write the pid file BEFORE unref-ing. If the write throws (disk full,
  // permissions), the exception propagates while Bun still tracks the child —
  // we never end up with a detached, orphaned dispatcher that `mm stop` can't
  // find and that a second `mm start` would duplicate.
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, String(proc.pid));
  proc.unref();

  console.log(`mm start: dispatcher started (pid ${proc.pid})`);
  return 0;
}

/** Probe `GET /health`; true only on `{ ok: true }`. Connection errors are "down". */
async function probeHealth(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`);
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    return body?.ok === true;
  } catch {
    return false;
  }
}

/** Poll `/health` until ready or the deadline. */
async function waitForHealthDefault(base: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probeHealth(base)) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(200);
  }
}

/** Open a URL with the platform's default opener (macOS `open`, Linux `xdg-open`, Windows `start`). */
function openUrlDefault(url: string): void {
  const argv =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  proc.unref();
}

/** Resolve the dispatcher port + the `windowed` default from config; fall back on any error. */
function resolveWindowConfig(configPath?: string): { port: number; windowed: boolean } {
  try {
    const config = loadConfig({ globalPath: configPath });
    return { port: config.global.dispatcherPort, windowed: config.dashboard.windowed };
  } catch {
    return { port: DEFAULT_DISPATCHER_PORT, windowed: false };
  }
}

/**
 * `mm start` (CLI entry) — start the dispatcher, then, when `--window` is set (or
 * `[dashboard] windowed` is true), wait for `/health` and open the queue
 * observability page (`GET /`). The window is best-effort: a daemon that never
 * comes ready, or a missing opener, is logged but never fails the start (the
 * daemon is already up regardless). Returns the start exit code.
 */
export async function runStartCommand(opts: StartOptions = {}): Promise<number> {
  const code = runStart(opts);
  if (code !== 0) return code;

  const { port, windowed } = resolveWindowConfig(opts.configPath);
  if (!(opts.window ?? windowed)) return code;

  const base = `http://127.0.0.1:${port}`;
  const ready = await (opts.waitForHealth ?? waitForHealthDefault)(
    base,
    opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
  );
  if (!ready) {
    console.error(`mm start: dispatcher not ready on ${base} — not opening the window`);
    return code;
  }
  const url = `${base}/`;
  (opts.openUrl ?? openUrlDefault)(url);
  console.log(`mm start: opened ${url}`);
  return code;
}
