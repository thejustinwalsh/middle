import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Verifies the dispatcher process entrypoint that `mm start` spawns and
// `mm stop` signals: it stands up the hook server, announces readiness, and
// shuts down cleanly on SIGTERM.

let dir: string;
let configPath: string;
const mainEntrypoint = join(import.meta.dir, "..", "src", "main.ts");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "middle-main-"));
  configPath = join(dir, "config.toml");
  writeFileSync(
    configPath,
    [
      "[global]",
      "dispatcher_port = 0", // ephemeral — main.ts prints the resolved port
      `db_path = "${join(dir, "db.sqlite3")}"`,
      `worktree_root = "${join(dir, "worktrees")}"`,
      `log_dir = "${join(dir, "logs")}"`,
      "",
    ].join("\n"),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("dispatcher main", () => {
  test("starts the hook server, announces readiness, and exits 0 on SIGTERM", async () => {
    const proc = Bun.spawn(["bun", mainEntrypoint], {
      env: { ...process.env, MIDDLE_CONFIG: configPath },
      stdout: "pipe",
      stderr: "pipe",
    });

    // wait for the readiness line
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    const deadline = Date.now() + 5000;
    while (!output.includes("dispatcher up") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      output += decoder.decode(value);
    }
    reader.releaseLock();
    expect(output).toContain("middle dispatcher up");

    proc.kill("SIGTERM");
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });
});
