/**
 * Integration (#213): runs the **real `mm verify-file-mode` CLI** end-to-end via
 * `Bun.spawn` — the "exercise the real path" requirement (Epic #143), not a
 * stubbed unit of the report formatter. The command boots, drives the file-mode
 * integration fixture (the same `runFileModeSmoke` CI runs), and prints the
 * structured report; this asserts the report's shape (every section named `PASS`,
 * the summary, the `all sections pass.` verdict) and exit code 0.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const SECTIONS = ["init", "author", "dispatch", "park", "answer", "resume", "complete"];

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

describe("mm verify-file-mode (real CLI)", () => {
  test(
    "drives the fixture and prints a green structured report, exit 0",
    async () => {
      const { code, stdout } = await runCli(["verify-file-mode"]);

      expect(stdout).toContain("middle — file-mode verification");
      // Every phase is named with a PASS line, in order.
      for (const name of SECTIONS) {
        expect(stdout).toMatch(new RegExp(`PASS\\s+${name}\\b`));
      }
      // The summary line counts all seven sections.
      expect(stdout).toMatch(/7\/7 sections passed in \d+ms/);
      // The verdict is the last meaningful line on success.
      const lines = stdout.trimEnd().split("\n");
      expect(lines.at(-1)).toBe("all sections pass.");
      expect(code).toBe(0);
    },
    { timeout: 30_000 },
  );

  test("--help exits 0 and documents the command", async () => {
    const { code, stdout } = await runCli(["verify-file-mode", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("verify-file-mode");
  });
});
