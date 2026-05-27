import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPathFix,
  bunPathSnippet,
  isDirOnPath,
  rcAlreadyConfigured,
  resolveShellRc,
} from "../src/checks/bun-path.ts";

describe("isDirOnPath", () => {
  test("true when present", () => {
    expect(isDirOnPath("/home/u/.bun/bin", "/usr/bin:/home/u/.bun/bin:/bin")).toBe(true);
  });
  test("false when absent", () => {
    expect(isDirOnPath("/home/u/.bun/bin", "/usr/bin:/bin")).toBe(false);
  });
  test("tolerates trailing slashes on either side", () => {
    expect(isDirOnPath("/home/u/.bun/bin/", "/usr/bin:/home/u/.bun/bin")).toBe(true);
    expect(isDirOnPath("/home/u/.bun/bin", "/home/u/.bun/bin/:/bin")).toBe(true);
  });
  test("false on empty PATH", () => {
    expect(isDirOnPath("/home/u/.bun/bin", "")).toBe(false);
  });
});

describe("resolveShellRc", () => {
  test("zsh", () => {
    expect(resolveShellRc("/bin/zsh", "/home/u")).toEqual({
      shell: "zsh",
      rcPath: "/home/u/.zshrc",
    });
  });
  test("bash", () => {
    expect(resolveShellRc("/usr/bin/bash", "/home/u")).toEqual({
      shell: "bash",
      rcPath: "/home/u/.bashrc",
    });
  });
  test("unknown shell", () => {
    expect(resolveShellRc("/bin/sh", "/home/u")).toEqual({ unknown: true });
    expect(resolveShellRc(undefined, "/home/u")).toEqual({ unknown: true });
  });
});

describe("bunPathSnippet", () => {
  test("HOME-relative form when dir is the canonical ~/.bun/bin", () => {
    const snippet = bunPathSnippet("/home/u/.bun/bin", "/home/u");
    expect(snippet).toContain('export BUN_INSTALL="$HOME/.bun"');
    expect(snippet).toContain('export PATH="$BUN_INSTALL/bin:$PATH"');
    expect(snippet.startsWith("# bun")).toBe(true);
  });
  test("literal form when dir is non-canonical", () => {
    const snippet = bunPathSnippet("/opt/bun/bin", "/home/u");
    expect(snippet).toContain('export PATH="/opt/bun/bin:$PATH"');
    expect(snippet).not.toContain("BUN_INSTALL");
  });
});

describe("rcAlreadyConfigured", () => {
  test("detects literal bin dir", () => {
    expect(rcAlreadyConfigured('export PATH="/home/u/.bun/bin:$PATH"', "/home/u/.bun/bin")).toBe(
      true,
    );
  });
  test("detects BUN_INSTALL form", () => {
    expect(rcAlreadyConfigured('export PATH="$BUN_INSTALL/bin:$PATH"', "/home/u/.bun/bin")).toBe(
      true,
    );
  });
  test("false on unrelated rc", () => {
    expect(rcAlreadyConfigured("export PATH=/usr/bin:$PATH\n", "/home/u/.bun/bin")).toBe(false);
  });
});

describe("applyPathFix", () => {
  const snippet = '# bun\nexport PATH="/x/.bun/bin:$PATH"';

  test("appends once and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "bunpath-"));
    const rcPath = join(dir, ".zshrc");
    try {
      writeFileSync(rcPath, "export PATH=/usr/bin:$PATH\n");

      const first = applyPathFix({ rcPath, snippet, binDir: "/x/.bun/bin" });
      expect(first).toEqual({ changed: true });
      expect(readFileSync(rcPath, "utf8")).toContain("/x/.bun/bin");

      const second = applyPathFix({ rcPath, snippet, binDir: "/x/.bun/bin" });
      expect(second).toEqual({ changed: false });
      // the snippet appears exactly once
      const matches = readFileSync(rcPath, "utf8").split("/x/.bun/bin").length - 1;
      expect(matches).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates content when the rc file is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "bunpath-"));
    const rcPath = join(dir, ".bashrc"); // not created
    try {
      const result = applyPathFix({ rcPath, snippet, binDir: "/x/.bun/bin" });
      expect(result).toEqual({ changed: true });
      expect(readFileSync(rcPath, "utf8")).toContain("/x/.bun/bin");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
