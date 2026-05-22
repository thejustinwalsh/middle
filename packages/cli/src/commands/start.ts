import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaultPidFile } from "../paths.ts";

export type StartOptions = {
  /** Override the pid-file path (defaults to `~/.middle/dispatcher.pid`). */
  pidFile?: string;
  /** Override the dispatcher entrypoint (defaults to `@middle/dispatcher`'s main). */
  entrypoint?: string;
};

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
