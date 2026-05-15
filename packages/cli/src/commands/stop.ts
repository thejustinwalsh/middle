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
  rmSync(pidFile, { force: true });

  if (!Number.isInteger(pid)) {
    console.error("mm stop: pid file was malformed — cleared it");
    return 1;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    console.log(`mm stop: dispatcher (pid ${pid}) was not running — cleared pid file`);
    return 0;
  }
  console.log(`mm stop: dispatcher stopped (pid ${pid})`);
  return 0;
}
