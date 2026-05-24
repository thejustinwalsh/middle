import { describe, expect, test } from "bun:test";
import type { DocsSettings } from "@middle/core";
import { join } from "node:path";
import { DOCS_TARGET_NAMES, resolveDocsTarget } from "../src/resolve.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const fixture = (name: string): string => join(FIXTURES, name);

/** A `[docs]` settings object with bot fields at their defaults. */
function docsConfig(over: Partial<DocsSettings>): DocsSettings {
  return { enabled: false, intervalMinutes: 60, adapter: "claude", write: false, ...over };
}

describe("resolveDocsTarget — detection", () => {
  test("detects Starlight from astro.config + @astrojs/starlight", () => {
    const target = resolveDocsTarget(fixture("starlight"));
    expect(target.name).toBe("starlight");
    expect(target.docsRoot).toBe("src/content/docs");
    expect(target.supportsLlmsTxt).toBe(true);
    expect(target.resolveOutputPath({ slug: "getting-started" })).toBe(
      "src/content/docs/getting-started.md",
    );
  });

  test("Starlight wins over co-resident TypeDoc", () => {
    const target = resolveDocsTarget(fixture("starlight-typedoc"));
    expect(target.name).toBe("starlight");
  });

  test("detects Docusaurus from docusaurus.config.js", () => {
    const target = resolveDocsTarget(fixture("docusaurus"));
    expect(target.name).toBe("docusaurus");
    expect(target.docsRoot).toBe("docs");
    expect(target.supportsLlmsTxt).toBe(false);
  });

  test("detects MkDocs and reads a custom docs_dir", () => {
    const target = resolveDocsTarget(fixture("mkdocs-custom"));
    expect(target.name).toBe("mkdocs");
    expect(target.docsRoot).toBe("site_docs");
  });

  test("detects MkDocs with the default docs_dir", () => {
    const target = resolveDocsTarget(fixture("mkdocs-default"));
    expect(target.name).toBe("mkdocs");
    expect(target.docsRoot).toBe("docs");
  });

  test("detects TypeDoc from typedoc.json and reads out", () => {
    const target = resolveDocsTarget(fixture("typedoc-json"));
    expect(target.name).toBe("typedoc");
    expect(target.docsRoot).toBe("api-reference");
  });

  test("detects TypeDoc from a package.json typedoc key", () => {
    const target = resolveDocsTarget(fixture("typedoc-pkg"));
    expect(target.name).toBe("typedoc");
    expect(target.docsRoot).toBe("typedocs");
  });
});

describe("resolveDocsTarget — markdown fallback", () => {
  test("falls back to markdown in docs/ when nothing is detected", () => {
    const target = resolveDocsTarget(fixture("plain"));
    expect(target.name).toBe("markdown");
    expect(target.docsRoot).toBe("docs");
    expect(target.supportsLlmsTxt).toBe(true);
    expect(target.resolveOutputPath({ slug: "guide/intro" })).toBe("docs/guide/intro.md");
  });

  test("a bare Astro site (no Starlight signal) does not match Starlight", () => {
    const target = resolveDocsTarget(fixture("astro-no-starlight"));
    expect(target.name).toBe("markdown");
  });

  test("resolves to markdown on a nonexistent path", () => {
    const target = resolveDocsTarget(fixture("does-not-exist"));
    expect(target.name).toBe("markdown");
  });
});

describe("resolveDocsTarget — config override", () => {
  test("tool override forces the framework, ignoring detection", () => {
    // The plain repo has no framework, yet the override forces docusaurus.
    const target = resolveDocsTarget(fixture("plain"), docsConfig({ tool: "docusaurus" }));
    expect(target.name).toBe("docusaurus");
    expect(target.docsRoot).toBe("docs");
  });

  test("tool override beats a detected framework", () => {
    // starlight fixture would detect Starlight; override forces mkdocs.
    const target = resolveDocsTarget(fixture("starlight"), docsConfig({ tool: "mkdocs" }));
    expect(target.name).toBe("mkdocs");
  });

  test("tool + path override sets both framework and root", () => {
    const target = resolveDocsTarget(fixture("plain"), docsConfig({ tool: "starlight", path: "site/docs" }));
    expect(target.name).toBe("starlight");
    expect(target.docsRoot).toBe("site/docs");
    expect(target.resolveOutputPath({ slug: "x" })).toBe("site/docs/x.md");
  });

  test("path override alone overrides a detected target's root", () => {
    const target = resolveDocsTarget(fixture("starlight"), docsConfig({ path: "custom/docs" }));
    expect(target.name).toBe("starlight");
    expect(target.docsRoot).toBe("custom/docs");
  });

  test("path override alone overrides the fallback root", () => {
    const target = resolveDocsTarget(fixture("plain"), docsConfig({ path: "documentation" }));
    expect(target.name).toBe("markdown");
    expect(target.docsRoot).toBe("documentation");
  });

  test("an unknown tool override throws with the valid names", () => {
    expect(() => resolveDocsTarget(fixture("plain"), docsConfig({ tool: "sphinx" }))).toThrow(
      /unknown docs tool "sphinx"/,
    );
  });
});

describe("resolveOutputPath — slug normalization", () => {
  test("strips a leading slash and an existing .md/.mdx extension", () => {
    const target = resolveDocsTarget(fixture("plain"));
    expect(target.resolveOutputPath({ slug: "/intro.mdx" })).toBe("docs/intro.md");
  });
});

describe("DOCS_TARGET_NAMES", () => {
  test("lists every resolvable target", () => {
    expect([...DOCS_TARGET_NAMES]).toEqual(["starlight", "docusaurus", "mkdocs", "typedoc", "markdown"]);
  });
});
