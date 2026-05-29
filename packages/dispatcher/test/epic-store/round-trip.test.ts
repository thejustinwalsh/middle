import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEpicFile } from "../../src/epic-store/epic-file/parser.ts";
import { renderEpicFile } from "../../src/epic-store/epic-file/renderer.ts";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");
const FIXTURE_FILES = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".md"));

/**
 * The load-bearing test. `renderEpicFile(parseEpicFile(body)) === body` for
 * every fixture. This property is what lets file mode work safely concurrent
 * (dispatcher and human both editing the file) without locking — round-trip
 * purity replaces a lock.
 */
describe("Epic file round-trip", () => {
  for (const file of FIXTURE_FILES) {
    test(`renderEpicFile(parseEpicFile(${file})) === ${file}`, () => {
      const body = readFileSync(join(FIXTURES_DIR, file), "utf8");
      const reparsed = parseEpicFile(body);
      const rendered = renderEpicFile(reparsed);
      expect(rendered).toBe(body);
    });
  }
});
