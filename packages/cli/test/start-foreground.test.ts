import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStartCommand } from "../src/commands/start.ts";

let dir: string;
let pidFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "middle-cli-foreground-"));
  pidFile = join(dir, "dispatcher.pid");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function silence(): () => void {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation(() => {});
  return () => {
    log.mockRestore();
    err.mockRestore();
  };
}

describe("runStartCommand --foreground (unit, injected runner)", () => {
  test("runs the in-process daemon and writes NO pid file", async () => {
    const restore = silence();
    let ran = false;
    try {
      const code = await runStartCommand({
        foreground: true,
        pidFile,
        runForeground: async () => {
          ran = true;
        },
      });
      expect(code).toBe(0);
      expect(ran).toBe(true);
      // The whole point of foreground: the service manager owns the lifecycle, so
      // mm must not fork or leave a pid file behind.
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      restore();
    }
  });

  test("does not take the fork path (the spawn entrypoint is never consulted)", async () => {
    const restore = silence();
    try {
      // A bogus entrypoint would make the *fork* path throw on spawn; foreground
      // must ignore it entirely and use the in-process runner.
      const code = await runStartCommand({
        foreground: true,
        pidFile,
        entrypoint: join(dir, "does-not-exist.ts"),
        runForeground: async () => {},
      });
      expect(code).toBe(0);
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      restore();
    }
  });

  test("refuses when a live dispatcher is already recorded (pidfile preflight)", async () => {
    const restore = silence();
    let ran = false;
    try {
      // The current test process is itself alive, so its pid stands in for a
      // running background dispatcher. Foreground must not launch a second one.
      writeFileSync(pidFile, String(process.pid));
      const code = await runStartCommand({
        foreground: true,
        pidFile,
        runForeground: async () => {
          ran = true;
        },
      });
      expect(code).toBe(1);
      expect(ran).toBe(false);
      // A live pidfile is left untouched — it belongs to the running daemon.
      expect(existsSync(pidFile)).toBe(true);
    } finally {
      restore();
    }
  });

  test("clears a stale pid file and runs (pidfile preflight)", async () => {
    const restore = silence();
    let ran = false;
    try {
      writeFileSync(pidFile, "999999999"); // a pid that is not alive
      const code = await runStartCommand({
        foreground: true,
        pidFile,
        runForeground: async () => {
          ran = true;
        },
      });
      expect(code).toBe(0);
      expect(ran).toBe(true);
      // The stale pidfile is removed; foreground itself writes none.
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      restore();
    }
  });
});

// Integration (sub-issue #218): boot the REAL `mm start --foreground` via
// Bun.spawn against an isolated HOME + config, confirm the daemon stays running
// (its /health answers), assert no pid file is written, and that SIGTERM is
// honored with a clean exit. This proves the systemd/launchd templates in
// docs/daemon-as-a-service.md work without manual workarounds.
describe("mm start --foreground (integration, real daemon boot)", () => {
  const CLI = join(import.meta.dir, "..", "src", "index.ts");
  const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

  // Pick an ephemeral free port at runtime instead of hard-coding one: a fixed
  // port makes the test flaky under parallel CI or when a local process already
  // owns it. Bind port 0, read what the OS assigned, then release it for the
  // daemon to claim.
  async function freePort(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const srv = createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        srv.close((err) => (err ? reject(err) : resolve(port)));
      });
    });
  }

  async function healthy(port: number, deadlineMs: number): Promise<boolean> {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
          if (body?.ok === true) return true;
        }
      } catch {
        // not up yet
      }
      await Bun.sleep(200);
    }
    return false;
  }

  test("stays running, writes no pid file, and exits cleanly on SIGTERM", async () => {
    const PORT = await freePort();
    const configPath = join(dir, "config.toml");
    writeFileSync(
      configPath,
      `[global]\ndb_path = "${join(dir, "db.sqlite3")}"\ndispatcher_port = ${PORT}\nlog_dir = "${join(dir, "logs")}"\nworktree_root = "${join(dir, "worktrees")}"\n`,
    );

    const proc = Bun.spawn(["bun", CLI, "start", "--foreground"], {
      cwd: REPO_ROOT,
      // Isolated HOME so the default pid path (~/.middle/dispatcher.pid) and the
      // db land under the temp dir, never the real ~/.middle.
      env: { ...process.env, HOME: dir, MIDDLE_CONFIG: configPath },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const ready = await healthy(PORT, 20_000);
      expect(ready).toBe(true);
      // Still running, and NO pid file written (the service manager owns lifecycle).
      expect(proc.killed).toBe(false);
      expect(existsSync(join(dir, ".middle", "dispatcher.pid"))).toBe(false);

      proc.kill("SIGTERM");
      const code = await proc.exited;
      // runDaemon's SIGTERM handler drains and process.exit(0) → a clean exit.
      expect(code).toBe(0);
      // Still no pid file after shutdown.
      expect(existsSync(join(dir, ".middle", "dispatcher.pid"))).toBe(false);
    } finally {
      if (!proc.killed) proc.kill("SIGKILL");
      await proc.exited.catch(() => {});
    }
  }, 30_000);
});
