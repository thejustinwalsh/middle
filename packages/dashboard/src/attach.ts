/**
 * tmux attach affordances. The copy-command path is the guaranteed-portable
 * fallback the spec leans on ("the copy-command path always works"); spawning
 * the operator's terminal is a best-effort convenience layered on top.
 *
 * `watch` is read-only (`-r`) and never collides with middle's `send-keys`
 * driving; `control` is read-write and is paired with a `controlled_by → human`
 * flip by the caller (this module only builds/spawns, never touches the db).
 */

/** Build the read-only and read-write `tmux attach` commands for a session. */
export function attachCommands(session: string): { watch: string; control: string } {
  // Single-quote the session name so a name with shell metacharacters can't be
  // reinterpreted when the operator pastes the command. tmux session names are
  // tame in practice, but the copy path is the trusted fallback — keep it safe.
  const q = `'${session.replace(/'/g, "'\\''")}'`;
  return {
    watch: `tmux attach -r -t ${q}`,
    control: `tmux attach -t ${q}`,
  };
}

/**
 * The terminal-emulator launchers tried in order. The dispatcher is a local
 * process, so it spawns the operator's terminal directly; which emulator exists
 * is environment-specific, so we probe a short list and fall back to the
 * copy-command path when none is found. Each entry maps a terminal binary to the
 * argv that runs a command in a new window.
 */
const TERMINAL_LAUNCHERS: Array<{ bin: string; args: (cmd: string) => string[] }> = [
  { bin: "ghostty", args: (cmd) => ["ghostty", "-e", "sh", "-c", cmd] },
  { bin: "wezterm", args: (cmd) => ["wezterm", "start", "--", "sh", "-c", cmd] },
  { bin: "kitty", args: (cmd) => ["kitty", "sh", "-c", cmd] },
  { bin: "alacritty", args: (cmd) => ["alacritty", "-e", "sh", "-c", cmd] },
  { bin: "gnome-terminal", args: (cmd) => ["gnome-terminal", "--", "sh", "-c", cmd] },
  { bin: "xterm", args: (cmd) => ["xterm", "-e", "sh", "-c", cmd] },
];

/** A spawner seam — injected so the real spawn is swapped for a stub in tests. */
export type TerminalSpawner = (command: string) => boolean;

/**
 * Spawn the operator's terminal running `command`, trying each known emulator
 * until one launches. Returns whether a terminal was spawned; `false` means the
 * caller should rely on the copy-command path. Never throws — a missing emulator
 * or a spawn failure is a `false`, not an error (the fallback always works).
 */
export function spawnTerminal(command: string): boolean {
  for (const launcher of TERMINAL_LAUNCHERS) {
    if (!Bun.which(launcher.bin)) continue;
    try {
      const proc = Bun.spawn(launcher.args(command), {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      proc.unref();
      return true;
    } catch {
      // Try the next emulator; a failure here is never fatal.
    }
  }
  return false;
}
