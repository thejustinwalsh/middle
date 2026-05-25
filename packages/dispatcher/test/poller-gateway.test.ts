import { describe, expect, test } from "bun:test";
import { type CheckRollupEntry, deriveCiStatus } from "../src/poller-gateway.ts";

/** A finished GitHub Actions check run. */
function run(conclusion: string): CheckRollupEntry {
  return { status: "COMPLETED", conclusion };
}

describe("deriveCiStatus", () => {
  test("no checks configured → none (nothing to gate on)", () => {
    expect(deriveCiStatus(null)).toBe("none");
    expect(deriveCiStatus([])).toBe("none");
  });

  test("all check runs succeeded (incl. neutral/skipped) → passing", () => {
    expect(deriveCiStatus([run("SUCCESS"), run("NEUTRAL"), run("SKIPPED")])).toBe("passing");
  });

  test("any failed/errored/cancelled/timed-out check → failing", () => {
    expect(deriveCiStatus([run("SUCCESS"), run("FAILURE")])).toBe("failing");
    expect(deriveCiStatus([run("TIMED_OUT")])).toBe("failing");
    expect(deriveCiStatus([run("CANCELLED")])).toBe("failing");
    expect(deriveCiStatus([run("ACTION_REQUIRED")])).toBe("failing");
  });

  test("an unfinished check run (not COMPLETED) → pending", () => {
    expect(deriveCiStatus([run("SUCCESS"), { status: "IN_PROGRESS" }])).toBe("pending");
    expect(deriveCiStatus([{ status: "QUEUED" }])).toBe("pending");
  });

  test("a failure outranks a still-running check → failing", () => {
    expect(deriveCiStatus([{ status: "IN_PROGRESS" }, run("FAILURE")])).toBe("failing");
  });

  test("legacy StatusContext entries (state) are read too", () => {
    expect(deriveCiStatus([{ state: "SUCCESS" }])).toBe("passing");
    expect(deriveCiStatus([{ state: "PENDING" }])).toBe("pending");
    expect(deriveCiStatus([{ state: "FAILURE" }])).toBe("failing");
    expect(deriveCiStatus([{ state: "ERROR" }])).toBe("failing");
  });
});
