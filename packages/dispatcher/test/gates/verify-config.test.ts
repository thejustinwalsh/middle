import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_GATE_TIMEOUT_SECONDS,
  gatesForPhase,
  integrationGates,
  loadVerifyConfig,
  parseVerifyConfig,
  VerifyConfigError,
  verifyConfigPath,
} from "../../src/gates/verify-config.ts";

/** Write `contents` to a throwaway file and return its path. */
function withTomlFile(contents: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "middle-verify-"));
  const path = join(dir, "verify.toml");
  writeFileSync(path, contents);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("parseVerifyConfig — valid", () => {
  test("parses gates in declared order and applies the default timeout", () => {
    const config = parseVerifyConfig(
      [
        "[[gate]]",
        'name = "typecheck"',
        'command = "bun run typecheck"',
        "",
        "[[gate]]",
        'name = "test"',
        'command = "bun test"',
        "timeout_seconds = 600",
      ].join("\n"),
    );
    expect(config.gates).toEqual([
      {
        name: "typecheck",
        command: "bun run typecheck",
        timeoutSeconds: DEFAULT_GATE_TIMEOUT_SECONDS,
        category: "unit",
      },
      { name: "test", command: "bun test", timeoutSeconds: 600, category: "unit" },
    ]);
  });

  test("carries an optional phases scope", () => {
    const config = parseVerifyConfig(
      ["[[gate]]", 'name = "acceptance"', 'command = "bun run accept"', "phases = [40, 41]"].join(
        "\n",
      ),
    );
    expect(config.gates[0]!.phases).toEqual([40, 41]);
  });

  test("category defaults to unit and accepts integration; integrationGates filters", () => {
    const config = parseVerifyConfig(
      [
        "[[gate]]",
        'name = "test"',
        'command = "bun test"',
        "",
        "[[gate]]",
        'name = "smoke"',
        'command = "bun test:smoke"',
        'category = "integration"',
      ].join("\n"),
    );
    expect(config.gates[0]!.category).toBe("unit");
    expect(config.gates[1]!.category).toBe("integration");
    expect(integrationGates(config).map((g) => g.name)).toEqual(["smoke"]);
  });
});

describe("gatesForPhase — per-phase addressing", () => {
  const config = parseVerifyConfig(
    [
      "[[gate]]",
      'name = "typecheck"',
      'command = "tc"',
      "",
      "[[gate]]",
      'name = "acceptance"',
      'command = "acc"',
      "phases = [40, 41]",
    ].join("\n"),
  );

  test("an unscoped gate runs for every phase", () => {
    expect(gatesForPhase(config, 99).map((g) => g.name)).toEqual(["typecheck"]);
  });

  test("a scoped gate runs only for its listed phases, preserving declared order", () => {
    expect(gatesForPhase(config, 40).map((g) => g.name)).toEqual(["typecheck", "acceptance"]);
  });
});

describe("parseVerifyConfig — malformed fails loudly", () => {
  const cases: Array<[string, string]> = [
    ["no gates", 'title = "nope"'],
    ["missing name", '[[gate]]\ncommand = "x"'],
    ["empty name", '[[gate]]\nname = "  "\ncommand = "x"'],
    ["missing command", '[[gate]]\nname = "x"'],
    ["empty command", '[[gate]]\nname = "x"\ncommand = ""'],
    ["duplicate name", '[[gate]]\nname = "x"\ncommand = "a"\n[[gate]]\nname = "x"\ncommand = "b"'],
    ["non-positive timeout", '[[gate]]\nname = "x"\ncommand = "a"\ntimeout_seconds = 0'],
    ["non-int phases", '[[gate]]\nname = "x"\ncommand = "a"\nphases = [1.5]'],
    ["negative phases", '[[gate]]\nname = "x"\ncommand = "a"\nphases = [-1]'],
    // An empty `phases = []` is a degenerate scope that matches no sub-issue:
    // the gate runs for *no* phase, silently disabling verification — the same
    // "fails loudly, never a silent zero-gate run" class as a typo'd key.
    ["empty phases", '[[gate]]\nname = "x"\ncommand = "a"\nphases = []'],
    ["unknown key", '[[gate]]\nname = "x"\ncommand = "a"\ncomand = "typo"'],
    ["invalid category", '[[gate]]\nname = "x"\ncommand = "a"\ncategory = "e2e"'],
    ["invalid toml", "[[gate]\nname = "],
  ];
  for (const [label, toml] of cases) {
    test(`rejects: ${label}`, () => {
      expect(() => parseVerifyConfig(toml)).toThrow(VerifyConfigError);
    });
  }
});

describe("loadVerifyConfig — file IO", () => {
  test("loads a valid file from disk", () => {
    const f = withTomlFile('[[gate]]\nname = "test"\ncommand = "bun test"');
    try {
      expect(loadVerifyConfig(f.path).gates[0]!.name).toBe("test");
    } finally {
      f.cleanup();
    }
  });

  test("a missing file fails loudly with the path in the message", () => {
    const missing = join(tmpdir(), "middle-verify-does-not-exist", "verify.toml");
    expect(() => loadVerifyConfig(missing)).toThrow(VerifyConfigError);
    expect(() => loadVerifyConfig(missing)).toThrow(/verify\.toml/);
  });

  test("verifyConfigPath resolves the worktree's .middle/verify.toml", () => {
    expect(verifyConfigPath("/wt")).toBe(join("/wt", ".middle", "verify.toml"));
  });
});
