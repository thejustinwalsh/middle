import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFileStateGateway } from "../../src/epic-store/file-state-gateway.ts";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "middle-state-"));
}

describe("fileStateGateway", () => {
  test("readBody returns the state file contents verbatim", async () => {
    const dir = tmpRepo();
    const stateFile = join(dir, ".middle", "state.md");
    const gw = makeFileStateGateway({ stateFile });
    await gw.writeBody("o/r", 0, "# state\n\nbody\n");
    expect(await gw.readBody("o/r", 0)).toBe("# state\n\nbody\n");
  });

  test("readBody throws a clear error when the state file is absent", async () => {
    const dir = tmpRepo();
    const gw = makeFileStateGateway({ stateFile: join(dir, "missing", "state.md") });
    await expect(gw.readBody("o/r", 0)).rejects.toThrow(/state file not found/);
  });

  test("writeBody creates the parent directory and round-trips", async () => {
    const dir = tmpRepo();
    const stateFile = join(dir, "nested", "deeper", "state.md");
    const gw = makeFileStateGateway({ stateFile });
    await gw.writeBody("o/r", 0, "hello\n");
    expect(readFileSync(stateFile, "utf8")).toBe("hello\n");
  });

  test("writeBody is atomic: leaves no `.tmp` sibling after a successful write", async () => {
    const dir = tmpRepo();
    const stateDir = join(dir, ".middle");
    const stateFile = join(stateDir, "state.md");
    const gw = makeFileStateGateway({ stateFile });
    await gw.writeBody("o/r", 0, "first\n");
    await gw.writeBody("o/r", 0, "second\n");
    expect(readFileSync(stateFile, "utf8")).toBe("second\n");
    expect(readdirSync(stateDir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("writeBody derives the temp sibling from the filename via `basename` (separator-safe)", async () => {
    const dir = tmpRepo();
    const stateDir = join(dir, "nested");
    // A multi-dot filename in a nested dir: the temp must be `.state.snapshot.md.tmp`
    // (basename of the file), a sibling inside `stateDir` — never derived by raw `/`
    // slicing of the full path.
    const stateFile = join(stateDir, "state.snapshot.md");
    const gw = makeFileStateGateway({ stateFile });
    await gw.writeBody("o/r", 0, "body\n");
    expect(readFileSync(stateFile, "utf8")).toBe("body\n");
    // No stray temp left, and nothing leaked outside the state dir.
    expect(readdirSync(stateDir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(readdirSync(dir)).toEqual(["nested"]);
  });

  test("writeBody overwrites an existing file", async () => {
    const dir = tmpRepo();
    const stateFile = join(dir, "state.md");
    writeFileSync(stateFile, "old\n");
    const gw = makeFileStateGateway({ stateFile });
    await gw.writeBody("o/r", 0, "new\n");
    expect(readFileSync(stateFile, "utf8")).toBe("new\n");
    expect(existsSync(stateFile)).toBe(true);
  });
});
