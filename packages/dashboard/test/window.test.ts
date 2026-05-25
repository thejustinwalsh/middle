import { describe, expect, test } from "bun:test";

// The optional webview window launcher (#59). webview-bun is an
// optionalDependency and isn't built in CI, so the launcher must degrade
// gracefully: a missing URL is a usage error (exit 2); an unavailable
// webview-bun logs and exits 0 (the dashboard is still served over HTTP). We
// run window.ts as its own process — which is exactly how `mm start --window`
// invokes it — so this also proves the import is isolated to that process.

const ENTRY = new URL("../src/window.ts", import.meta.url).pathname;

async function runLauncher(args: string[]): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["bun", ENTRY, ...args], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stderr };
}

describe("dashboard window launcher", () => {
  test("missing URL argument is a usage error (exit 2)", async () => {
    const { code, stderr } = await runLauncher([]);
    expect(code).toBe(2);
    expect(stderr).toContain("missing URL");
  });

  test("an unavailable webview-bun degrades to a logged exit 0 (HTTP still serves)", async () => {
    // webview-bun is an optionalDependency, absent in CI → the dynamic import
    // throws, the launcher logs and exits 0 rather than crashing the start.
    const { code, stderr } = await runLauncher(["http://127.0.0.1:8822/"]);
    expect(code).toBe(0);
    expect(stderr).toContain("webview-bun unavailable");
    expect(stderr).toContain("http://127.0.0.1:8822/");
  });
});
