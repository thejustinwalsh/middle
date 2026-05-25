import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@middle/core";
import { runConfig } from "../src/commands/config.ts";

let dir: string;
let configFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "middle-cli-config-"));
  configFile = join(dir, "config.toml");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function silence<T>(fn: () => T): T {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    return fn();
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

describe("mm config auto_dispatch", () => {
  test("flips an existing toggle in place, preserving comments and other keys", () => {
    writeFileSync(
      configFile,
      `[recommender]
enabled = true
# opt in per repo
auto_dispatch = false
interval_minutes = 15
`,
    );
    const code = silence(() => runConfig(dir, "auto_dispatch", "true", { configFile }));
    expect(code).toBe(0);
    const text = readFileSync(configFile, "utf8");
    expect(text).toContain("auto_dispatch = true");
    // Comment and siblings survive untouched.
    expect(text).toContain("# opt in per repo");
    expect(text).toContain("interval_minutes = 15");
    expect(text).toContain("enabled = true");
    // And the merged config reflects it.
    expect(loadConfig({ repoPath: configFile }).recommender?.autoDispatch).toBe(true);
  });

  test("inserts the key when the [recommender] section lacks it", () => {
    writeFileSync(configFile, `[recommender]\nenabled = true\n`);
    expect(silence(() => runConfig(dir, "auto_dispatch", "true", { configFile }))).toBe(0);
    expect(loadConfig({ repoPath: configFile }).recommender?.autoDispatch).toBe(true);
  });

  test("appends the section when it does not exist", () => {
    writeFileSync(configFile, `[repo]\nowner = "o"\nname = "r"\n`);
    expect(silence(() => runConfig(dir, "auto_dispatch", "false", { configFile }))).toBe(0);
    const cfg = loadConfig({ repoPath: configFile });
    expect(cfg.recommender?.autoDispatch).toBe(false);
    expect(cfg.repo?.owner).toBe("o"); // untouched
  });

  test("rejects an unknown key and an invalid value", () => {
    writeFileSync(configFile, `[recommender]\nauto_dispatch = false\n`);
    expect(silence(() => runConfig(dir, "nonsense", "true", { configFile }))).toBe(1);
    expect(silence(() => runConfig(dir, "auto_dispatch", "yes", { configFile }))).toBe(1);
    // The file was not mutated by a rejected call.
    expect(readFileSync(configFile, "utf8")).toContain("auto_dispatch = false");
  });

  test("errors when the config file is missing", () => {
    expect(silence(() => runConfig(dir, "auto_dispatch", "true", { configFile }))).toBe(1);
  });
});
