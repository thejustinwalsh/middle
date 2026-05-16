import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { capturePane, pollPaneFor, sendKeys, sendText } from "../src/tmux-tui.ts";

const TMUX = Bun.which("tmux");
const d = describe.skipIf(!TMUX);

const created: string[] = [];

function uniqueName(): string {
  const name = `middle-tui-${crypto.randomUUID().slice(0, 8)}`;
  created.push(name);
  return name;
}

async function killAll(): Promise<void> {
  while (created.length > 0) {
    const name = created.pop()!;
    const proc = Bun.spawn(["tmux", "kill-session", "-t", name], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  }
}

afterEach(async () => {
  await killAll();
});

async function newSession(name: string, cmd: string[]): Promise<void> {
  const proc = Bun.spawn(["tmux", "new-session", "-d", "-s", name, "-x", "80", "-y", "24", ...cmd], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`tmux new-session failed: ${await new Response(proc.stderr).text()}`);
  }
}

d("capturePane", () => {
  test("returns the visible pane contents of a live session", async () => {
    const name = uniqueName();
    await newSession(name, ["sh", "-c", "echo BEACON-12345; sleep 5"]);
    await Bun.sleep(150);
    const pane = await capturePane(name);
    expect(pane).not.toBeNull();
    expect(pane!).toContain("BEACON-12345");
  });

  test("returns null for an unknown session", async () => {
    const result = await capturePane("middle-tui-does-not-exist-xyz");
    expect(result).toBeNull();
  });
});

d("sendText and sendKeys", () => {
  test("sendText writes literal text into the pane", async () => {
    const name = uniqueName();
    await newSession(name, ["cat"]);
    await sendText(name, "literal-payload-789");
    await sendKeys(name, ["Enter"]);
    await Bun.sleep(150);
    const pane = await capturePane(name);
    expect(pane!).toContain("literal-payload-789");
  });

  test("sendKeys with delayBetweenMs sends each key in its own call", async () => {
    const name = uniqueName();
    await newSession(name, ["cat"]);
    await sendKeys(name, ["a", "b", "c"], { delayBetweenMs: 30 });
    await sendKeys(name, ["Enter"]);
    await Bun.sleep(150);
    const pane = await capturePane(name);
    expect(pane!).toContain("abc");
  });
});

d("pollPaneFor", () => {
  test("resolves with the predicate's value when the pane matches", async () => {
    const name = uniqueName();
    // session prints the marker after a small delay so polling has to actually iterate
    await newSession(name, ["sh", "-c", "sleep 0.3; echo READY-MARKER-42; sleep 5"]);
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await pollPaneFor<string>(
        name,
        (pane) => (pane.includes("READY-MARKER-42") ? "matched" : null),
        { timeoutMs: 2000, pollIntervalMs: 100 },
      );
      expect(result).toBe("matched");
    } finally {
      errSpy.mockRestore();
    }
  });

  test("returns null on timeout when the pane never matches", async () => {
    const name = uniqueName();
    await newSession(name, ["sh", "-c", "echo BORING; sleep 5"]);
    const result = await pollPaneFor<string>(
      name,
      () => null,
      { timeoutMs: 400, pollIntervalMs: 100 },
    );
    expect(result).toBeNull();
  });

  test("returns null and bails when the session disappears", async () => {
    const result = await pollPaneFor<string>(
      "middle-tui-vanished-xyz",
      () => "match",
      { timeoutMs: 2000, pollIntervalMs: 100 },
    );
    expect(result).toBeNull();
  });

  test("when `tag` is set, writes one stderr line per iteration", async () => {
    const name = uniqueName();
    await newSession(name, ["sh", "-c", "echo HI; sleep 5"]);
    const lines: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    try {
      await pollPaneFor<string>(name, () => "stop", {
        timeoutMs: 500,
        pollIntervalMs: 100,
        tag: "test-tag",
      });
    } finally {
      errSpy.mockRestore();
    }
    expect(lines.some((line) => line.includes("[test-tag] pollPaneFor"))).toBe(true);
  });
});
