import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Gate } from "../../src/gates/verify-config.ts";
import { runGate, runGates } from "../../src/gates/gate-runner.ts";

/** A scratch worktree-like directory the gates run inside. */
function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "middle-gate-run-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function gate(over: Partial<Gate> & Pick<Gate, "name" | "command">): Gate {
  return { timeoutSeconds: 30, ...over };
}

describe("runGate", () => {
  test("a passing gate captures stdout and exit 0", async () => {
    const r = await runGate(gate({ name: "ok", command: "echo hello" }), { cwd: tmpdir() });
    expect(r.passed).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toContain("hello");
  });

  test("a failing gate captures the non-zero exit and stderr", async () => {
    const r = await runGate(
      gate({ name: "fail", command: "echo boom >&2; exit 3" }),
      { cwd: tmpdir() },
    );
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(r.stderr).toContain("boom");
  });

  test("a gate that exceeds its timeout is killed and reported as timed out", async () => {
    const start = Date.now();
    const r = await runGate(
      gate({ name: "slow", command: "sleep 10", timeoutSeconds: 0.2 }),
      { cwd: tmpdir() },
    );
    expect(r.timedOut).toBe(true);
    expect(r.passed).toBe(false);
    // It must return promptly — not wait out the full sleep.
    expect(Date.now() - start).toBeLessThan(3000);
  });

  test("runs in the given cwd", async () => {
    const s = scratch();
    try {
      writeFileSync(join(s.dir, "marker.txt"), "x");
      const r = await runGate(gate({ name: "ls", command: "ls" }), { cwd: s.dir });
      expect(r.stdout).toContain("marker.txt");
    } finally {
      s.cleanup();
    }
  });
});

describe("runGates", () => {
  test("runs every gate in declared order; aggregate ok when all pass", async () => {
    const report = await runGates(
      [gate({ name: "a", command: "echo a" }), gate({ name: "b", command: "echo b" })],
      { cwd: tmpdir() },
    );
    expect(report.ok).toBe(true);
    expect(report.results.map((r) => r.name)).toEqual(["a", "b"]);
    expect(report.failedGate).toBeUndefined();
  });

  test("a failing gate makes the aggregate fail and names the first failure; later gates still run", async () => {
    const report = await runGates(
      [
        gate({ name: "tc", command: "echo ok" }),
        gate({ name: "test", command: "exit 1" }),
        gate({ name: "accept", command: "echo also-ran" }),
      ],
      { cwd: tmpdir() },
    );
    expect(report.ok).toBe(false);
    expect(report.failedGate).toBe("test");
    // every gate ran — evidence is complete, not short-circuited
    expect(report.results.map((r) => r.name)).toEqual(["tc", "test", "accept"]);
    expect(report.results[2]!.stdout).toContain("also-ran");
  });

  test("an empty gate list is a vacuous pass", async () => {
    const report = await runGates([], { cwd: tmpdir() });
    expect(report.ok).toBe(true);
    expect(report.results).toEqual([]);
  });
});
