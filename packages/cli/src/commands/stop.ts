import { existsSync, readFileSync, rmSync } from "node:fs";
import { defaultPidFile } from "../paths.ts";

export type StopOptions = {
  /** Override the pid-file path (defaults to `~/.middle/dispatcher.pid`). */
  pidFile?: string;
};

/**
 * `mm stop` — read the recorded dispatcher pid, SIGTERM it, and clear the pid
 * file. A missing pid file means nothing is running (exit 1); a pid that is
 * already gone is treated as a clean stop. Returns a process exit code.
 */
export function runStop(opts: StopOptions = {}): number {
  const pidFile = opts.pidFile ?? defaultPidFile();

  if (!existsSync(pidFile)) {
    console.error("mm stop: dispatcher not running (no pid file)");
    return 1;
  }

  const pid = Number(readFileSync(pidFile, "utf8").trim());

  // Reject pid <= 0: process.kill(0, …) / negative pids target process groups,
  // not the single dispatcher. A malformed pid file is cleared as junk.
  if (!Number.isInteger(pid) || pid <= 0) {
    rmSync(pidFile, { force: true });
    console.error("mm stop: pid file was malformed — cleared it");
    return 1;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      // No such process — already gone. Safe to clear the stale pid file.
      rmSync(pidFile, { force: true });
      console.log(`mm stop: dispatcher (pid ${pid}) was not running — cleared pid file`);
      return 0;
    }
    // EPERM or anything else: the process may still be alive. Do NOT clear the
    // pid file (that would orphan a live dispatcher from `mm stop`'s view).
    console.error(`mm stop: failed to signal pid ${pid} — ${(error as Error).message}`);
    return 1;
  }

  rmSync(pidFile, { force: true });
  console.log(`mm stop: dispatcher stopped (pid ${pid})`);
  return 0;
}
