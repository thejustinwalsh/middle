import { homedir } from "node:os";
import { join } from "node:path";

/** middle's per-user home — `~/.middle`. */
export function middleHome(): string {
  return join(homedir(), ".middle");
}

/** Where `mm start` records the dispatcher process id for `mm stop` to find. */
export function defaultPidFile(): string {
  return join(middleHome(), "dispatcher.pid");
}
