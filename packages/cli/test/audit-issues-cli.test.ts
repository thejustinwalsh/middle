/**
 * Integration-verified self-audit (Epic #143, sub-issue #144): this test runs
 * the **real `mm audit-issues` CLI** end-to-end against fixture issue bodies —
 * the dogfooded "exercise the real path" requirement the auditor itself demands,
 * not merely a unit test of the rubric predicate.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "index.ts");

const WEAK = [
  "## Acceptance criteria",
  "- [ ] the parser works correctly",
  "- [ ] unit tests pass",
  "",
  "## Out of scope",
  "- nothing",
].join("\n");

const WELL_FORMED = [
  "## Acceptance criteria",
  "- [ ] `parseFoo` returns a Foo for valid input",
  "- [ ] `mm foo` serves the result; an integration test boots the daemon and GETs `/foo`, asserting the JSON shape",
].join("\n");

/**
 * Spawn the real CLI; return exit code with `stdout`/`stderr` separated (and
 * `out` as their concatenation for convenience). JSON-mode assertions must parse
 * `stdout` alone — combining stderr in can make `JSON.parse` flaky if a runtime
 * warning is emitted on stderr.
 */
async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string; out: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr, out: stdout + stderr };
}

describe("mm audit-issues --body-file (real CLI)", () => {
  let dir: string;
  let weakPath: string;
  let goodPath: string;
  function setup() {
    dir = mkdtempSync(join(tmpdir(), "audit-issues-"));
    weakPath = join(dir, "weak.md");
    goodPath = join(dir, "good.md");
    writeFileSync(weakPath, WEAK);
    writeFileSync(goodPath, WELL_FORMED);
  }
  function teardown() {
    rmSync(dir, { recursive: true, force: true });
  }

  test("flags a weak issue and suggests a concrete rewrite (exit 1)", async () => {
    setup();
    try {
      const { code, out } = await runCli([
        "audit-issues",
        ".",
        "--body-file",
        weakPath,
        "--title",
        "Foo feature",
      ]);
      expect(code).toBe(1);
      expect(out).toContain("FAIL");
      expect(out).toContain("Foo feature");
      expect(out).toContain("smoke test");
    } finally {
      teardown();
    }
  });

  test("passes a well-formed issue carrying an integration criterion (exit 0)", async () => {
    setup();
    try {
      const { code, out } = await runCli([
        "audit-issues",
        ".",
        "--body-file",
        goodPath,
        "--title",
        "Foo feature",
      ]);
      expect(code).toBe(0);
      expect(out).toContain("PASS");
    } finally {
      teardown();
    }
  });

  test("--json emits a machine-readable report", async () => {
    setup();
    try {
      const { code, stdout } = await runCli([
        "audit-issues",
        ".",
        "--body-file",
        weakPath,
        "--json",
      ]);
      expect(code).toBe(1);
      const parsed = JSON.parse(stdout) as { finding: { pass: boolean } }[];
      expect(parsed[0]!.finding.pass).toBe(false);
    } finally {
      teardown();
    }
  });

  test("rejects a non-positive-integer --issue with a clear error (exit 1)", async () => {
    for (const bad of ["abc", "12abc", "0", "-3", "3.9"]) {
      const { code, stderr } = await runCli(["audit-issues", ".", "--issue", bad]);
      expect(code).toBe(1);
      expect(stderr).toContain("--issue must be a positive integer");
    }
  });
});
