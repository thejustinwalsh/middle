import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTarget, readJsonIfExists } from "../src/detectors/util.ts";

describe("makeTarget.resolveOutputPath — path safety", () => {
  const target = makeTarget({ name: "markdown", docsRoot: "docs", supportsLlmsTxt: true });

  test("nested slugs route into subfolders (preserved behavior)", () => {
    expect(target.resolveOutputPath({ slug: "guide/intro" })).toBe("docs/guide/intro.md");
  });

  test("leading slashes are stripped, never absolute", () => {
    expect(target.resolveOutputPath({ slug: "/guide" })).toBe("docs/guide.md");
  });

  test("an .md/.mdx extension on the slug is not doubled", () => {
    expect(target.resolveOutputPath({ slug: "intro.mdx" })).toBe("docs/intro.md");
  });

  test("traversal segments cannot escape docsRoot", () => {
    const out = target.resolveOutputPath({ slug: "../../etc/passwd" });
    expect(out).toBe("docs/etc/passwd.md");
    expect(out).not.toContain("..");
  });

  test("interior traversal segments are dropped too", () => {
    expect(target.resolveOutputPath({ slug: "a/../../b" })).toBe("docs/a/b.md");
  });

  test("backslashes are normalized to POSIX separators", () => {
    expect(target.resolveOutputPath({ slug: "guide\\intro" })).toBe("docs/guide/intro.md");
  });

  test("an empty docsRoot stays repo-relative (no leading slash)", () => {
    const t = makeTarget({ name: "markdown", docsRoot: "./", supportsLlmsTxt: true });
    expect(t.docsRoot).toBe("");
    const out = t.resolveOutputPath({ slug: "page" });
    expect(out).toBe("page.md");
    expect(out.startsWith("/")).toBe(false);
  });
});

describe("readJsonIfExists — contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "middle-docs-util-"));

  test("a JSON object is returned as a Record", () => {
    writeFileSync(join(dir, "obj.json"), JSON.stringify({ a: 1 }));
    expect(readJsonIfExists(dir, "obj.json")).toEqual({ a: 1 });
  });

  test("a JSON array is rejected (not a Record<string, unknown>)", () => {
    writeFileSync(join(dir, "arr.json"), JSON.stringify([1, 2, 3]));
    expect(readJsonIfExists(dir, "arr.json")).toBeNull();
  });

  test("a JSON scalar is rejected", () => {
    writeFileSync(join(dir, "scalar.json"), "42");
    expect(readJsonIfExists(dir, "scalar.json")).toBeNull();
  });
});
