import { afterEach, describe, expect, test } from "bun:test";
import {
  capturePane,
  hasSession,
  killSession,
  newSession,
  sendEnter,
  sendText,
  status,
  TmuxError,
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
});
