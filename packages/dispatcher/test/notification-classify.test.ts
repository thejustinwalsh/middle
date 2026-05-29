import { describe, expect, test } from "bun:test";
import { classifyNotification } from "../src/notification-classify.ts";

describe("classifyNotification — permission blocks", () => {
  test.each([
    "Claude needs your permission to use Bash",
    "Claude needs permission to run a command",
    "This action requires your approval",
    "Claude wants to use the Edit tool",
    "Allow Claude to run `chmod +x`?",
  ])("message %p → permission", (message) => {
    expect(classifyNotification({ message, pane: "" })).toBe("permission");
  });

  test.each(["Do you want to proceed?", "Do you want to allow this?", "❯ 1. Yes", "❯ 2. Allow"])(
    "pane %p → permission even with a generic message",
    (pane) => {
      expect(classifyNotification({ message: "Claude is notifying you", pane })).toBe("permission");
    },
  );

  test("permission outranks an input-shaped message when the pane shows a dialog", () => {
    expect(
      classifyNotification({ message: "Claude is waiting for your input", pane: "❯ 1. Yes" }),
    ).toBe("permission");
  });
});

describe("classifyNotification — input (genuine question)", () => {
  test.each([
    "Claude is waiting for your input",
    "Waiting for input",
    "Claude needs your input to continue",
    "Awaiting your input",
  ])("message %p → input", (message) => {
    expect(classifyNotification({ message, pane: "" })).toBe("input");
  });
});

describe("classifyNotification — idle/unknown", () => {
  test.each(["", "Some unrelated notification", "Task finished"])(
    "unattributable message %p → idle-unknown",
    (message) => {
      expect(classifyNotification({ message, pane: "regular pane output" })).toBe("idle-unknown");
    },
  );

  test("a long whitespace-laden 'allow …' message classifies fast (no catastrophic backtracking)", () => {
    // The `allow … to` arm must be bounded — a `.+` between whitespace anchors
    // backtracks catastrophically on these, stalling the single-threaded daemon.
    const inputs = [
      `allow ${" ".repeat(6000)}`,
      `Please allow the operation ${"x ".repeat(2000)}`,
      `allow\n${"\n".repeat(4000)}`,
    ];
    for (const message of inputs) {
      const start = performance.now();
      classifyNotification({ message, pane: "" });
      expect(performance.now() - start).toBeLessThan(100);
    }
  });

  test("still matches a legitimate 'allow … to' permission request", () => {
    expect(classifyNotification({ message: "Allow Claude to run `chmod +x`?", pane: "" })).toBe(
      "permission",
    );
    expect(classifyNotification({ message: "allow the agent to use Bash", pane: "" })).toBe(
      "permission",
    );
  });

  test("tolerates missing message/pane (undefined-safe)", () => {
    expect(
      classifyNotification({
        message: undefined as unknown as string,
        pane: undefined as unknown as string,
      }),
    ).toBe("idle-unknown");
  });
});
