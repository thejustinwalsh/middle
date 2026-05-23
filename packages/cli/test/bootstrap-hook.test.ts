import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { HOOK_SH } from "@middle/core";

/**
 * The committed bootstrap asset is what `mm init` stamps into a target repo
 * (Phase 3). It must stay byte-identical to the canonical `HOOK_SH` constant in
 * `@middle/core` (the same content the Claude adapter writes into worktrees), so
 * an agent's hooks behave the same whether the repo was `mm init`'d or freshly
 * worktree'd. This is the drift guard.
 */
const ASSET_PATH = join(import.meta.dir, "..", "src", "bootstrap-assets", "hooks", "hook.sh");

describe("bootstrap hook.sh asset", () => {
  test("is byte-identical to the canonical HOOK_SH constant", async () => {
    const onDisk = await Bun.file(ASSET_PATH).text();
    expect(onDisk).toBe(HOOK_SH);
  });

  test("is a POSIX sh script that takes the event name and never blocks the agent", () => {
    expect(HOOK_SH).toStartWith("#!/bin/sh");
    expect(HOOK_SH).toContain('EVENT="$1"');
    // POSTs to the dispatcher with the three correlation headers
    expect(HOOK_SH).toContain("${MIDDLE_DISPATCHER_URL}/hooks/${EVENT}");
    expect(HOOK_SH).toContain("X-Middle-Session: ${MIDDLE_SESSION}");
    expect(HOOK_SH).toContain("X-Middle-Token: ${MIDDLE_SESSION_TOKEN}");
    expect(HOOK_SH).toContain("X-Middle-Epic: ${MIDDLE_EPIC}");
    // 3s ceiling, failure is a no-op, always exits 0
    expect(HOOK_SH).toContain("--max-time 3");
    expect(HOOK_SH).toContain("|| true");
    expect(HOOK_SH.trimEnd()).toEndWith("exit 0");
  });

  test("the committed asset is marked executable", () => {
    expect((statSync(ASSET_PATH).mode & 0o111) !== 0).toBe(true);
  });
});
