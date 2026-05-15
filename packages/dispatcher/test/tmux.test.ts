import { afterEach, describe, expect, test } from "bun:test";
import {
  capturePane,
  getTmuxVersion,
  hasSession,
  killSession,
  MIN_TMUX_VERSION,
  newSession,
  parseTmuxVersion,
  sendEnter,
  sendText,
  status,
  TmuxError,
  tmuxVersionAtLeast,
} from "../src/tmux.ts";

const TMUX = Bun.which("tmux");
const d = describe.skipIf(!TMUX);

const created: string[] = [];

function uniqueName(): string {
  const name = `middle-test-${crypto.randomUUID().slice(0, 8)}`;
  created.push(name);
  return name;
}

afterEach(async () => {
  while (created.length > 0) {
    const name = created.pop()!;
    try {
      await killSession(name);
    } catch {
      // best-effort cleanup
    }
  }
});

d("tmux session lifecycle", () => {
  test("launch → has-session → send-text → capture-pane → kill", async () => {
    const name = uniqueName();
    await newSession({ sessionName: name, command: ["cat"] });
    expect(await hasSession(name)).toBe(true);

    await sendText(name, "hello world");
    await sendEnter(name);
    await Bun.sleep(250);
    expect(await capturePane(name)).toContain("hello world");

    const s = await status(name);
    expect(s.alive).toBe(true);
    expect(s.paneCount).toBeGreaterThanOrEqual(1);

    await killSession(name);
    expect(await hasSession(name)).toBe(false);
  });

  test("newSession injects env via -e KEY=val", async () => {
    const name = uniqueName();
    await newSession({
      sessionName: name,
      command: ["sh", "-c", "echo VAR=$MIDDLE_TEST_VAR; sleep 5"],
      env: { MIDDLE_TEST_VAR: "injected-value" },
    });
    await Bun.sleep(250);
    expect(await capturePane(name)).toContain("VAR=injected-value");
  });

  test("hasSession is false for an unknown session", async () => {
    expect(await hasSession(`middle-test-nonexistent-${crypto.randomUUID().slice(0, 8)}`)).toBe(
      false,
    );
  });

  test("status reports not-alive for an unknown session", async () => {
    const s = await status(`middle-test-nonexistent-${crypto.randomUUID().slice(0, 8)}`);
    expect(s.alive).toBe(false);
    expect(s.paneCount).toBe(0);
  });

  test("killSession on an already-gone session is a no-op, not a throw", async () => {
    const name = `middle-test-gone-${crypto.randomUUID().slice(0, 8)}`;
    await killSession(name); // must not throw
    expect(await hasSession(name)).toBe(false);
  });

  test("newSession rejects a duplicate session name with a TmuxError", async () => {
    const name = uniqueName();
    await newSession({ sessionName: name, command: ["cat"] });
    await expect(newSession({ sessionName: name, command: ["cat"] })).rejects.toBeInstanceOf(
      TmuxError,
    );
  });

  test("getTmuxVersion parses the installed tmux's version", async () => {
    const v = await getTmuxVersion();
    expect(v).not.toBeNull();
    expect(v!.major).toBeGreaterThanOrEqual(2);
  });
});

describe("parseTmuxVersion", () => {
  test("parses release versions", () => {
    expect(parseTmuxVersion("tmux 3.5")).toEqual({ major: 3, minor: 5, raw: "tmux 3.5" });
    expect(parseTmuxVersion("tmux 3.4")).toEqual({ major: 3, minor: 4, raw: "tmux 3.4" });
  });

  test("parses pre-release builds (next-X.Y, X.Ya)", () => {
    const next = parseTmuxVersion("tmux next-3.6");
    expect(next?.major).toBe(3);
    expect(next?.minor).toBe(6);
    const patched = parseTmuxVersion("tmux 3.5a");
    expect(patched?.major).toBe(3);
    expect(patched?.minor).toBe(5);
  });

  test("returns null on garbage input", () => {
    expect(parseTmuxVersion("")).toBeNull();
    expect(parseTmuxVersion("not tmux at all")).toBeNull();
  });
});

describe("tmuxVersionAtLeast", () => {
  test("compares major then minor against the threshold", () => {
    expect(tmuxVersionAtLeast({ major: 3, minor: 5, raw: "" }, MIN_TMUX_VERSION)).toBe(true);
    expect(tmuxVersionAtLeast({ major: 3, minor: 6, raw: "" }, MIN_TMUX_VERSION)).toBe(true);
    expect(tmuxVersionAtLeast({ major: 4, minor: 0, raw: "" }, MIN_TMUX_VERSION)).toBe(true);
    expect(tmuxVersionAtLeast({ major: 3, minor: 4, raw: "" }, MIN_TMUX_VERSION)).toBe(false);
    expect(tmuxVersionAtLeast({ major: 2, minor: 9, raw: "" }, MIN_TMUX_VERSION)).toBe(false);
  });
});
