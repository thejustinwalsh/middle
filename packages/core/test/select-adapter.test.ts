import { describe, expect, test } from "bun:test";
import { selectAdapter } from "../src/select-adapter.ts";

const AVAILABLE = ["claude", "codex"] as const;

describe("selectAdapter — rule 1: explicit agent:<name> label overrides", () => {
  test("an agent:<name> label pins that adapter over the default", () => {
    const result = selectAdapter({
      labels: ["epic", "agent:codex", "phase:10"],
      defaultAdapter: "claude",
      available: AVAILABLE,
    });
    expect(result.adapter).toBe("codex");
    expect(result.source).toBe("label");
    expect(result.skip).toBe(false);
  });

  test("whitespace around the label and name is tolerated", () => {
    const result = selectAdapter({
      labels: ["  agent:codex  "],
      defaultAdapter: "claude",
      available: AVAILABLE,
    });
    expect(result.adapter).toBe("codex");
    expect(result.source).toBe("label");
  });

  test("conflicting agent labels throw", () => {
    expect(() =>
      selectAdapter({
        labels: ["agent:claude", "agent:codex"],
        defaultAdapter: "claude",
        available: AVAILABLE,
      }),
    ).toThrow(/conflicting adapter labels/);
  });

  test("duplicate agent labels for the same name are not a conflict", () => {
    const result = selectAdapter({
      labels: ["agent:codex", "agent:codex"],
      defaultAdapter: "claude",
      available: AVAILABLE,
    });
    expect(result.adapter).toBe("codex");
  });

  test("a label naming an unconfigured adapter throws", () => {
    expect(() =>
      selectAdapter({ labels: ["agent:ghost"], defaultAdapter: "claude", available: AVAILABLE }),
    ).toThrow(/not configured/);
  });
});

describe("selectAdapter — rule 2: default adapter", () => {
  test("with no agent label, the default adapter is chosen", () => {
    const result = selectAdapter({
      labels: ["epic", "phase:10"],
      defaultAdapter: "claude",
      available: AVAILABLE,
    });
    expect(result.adapter).toBe("claude");
    expect(result.source).toBe("default");
    expect(result.skip).toBe(false);
  });

  test("a default adapter that isn't configured throws", () => {
    expect(() =>
      selectAdapter({ labels: [], defaultAdapter: "ghost", available: AVAILABLE }),
    ).toThrow(/default adapter "ghost" is not configured/);
  });
});

describe("selectAdapter — rule 3: switch away from a rate-limited adapter when portable", () => {
  test("a rate-limited default switches to an available adapter for a portable task", () => {
    const result = selectAdapter({
      labels: [],
      defaultAdapter: "claude",
      available: AVAILABLE,
      rateLimited: new Set(["claude"]),
      portable: true,
    });
    expect(result.adapter).toBe("codex");
    expect(result.source).toBe("switched");
    expect(result.skip).toBe(false);
  });

  test("a label pin is never switched away from, even when rate-limited and portable", () => {
    const result = selectAdapter({
      labels: ["agent:claude"],
      defaultAdapter: "codex",
      available: AVAILABLE,
      rateLimited: new Set(["claude"]),
      portable: true,
    });
    expect(result.adapter).toBe("claude");
    expect(result.source).toBe("label");
    expect(result.skip).toBe(true); // pinned + rate-limited → skip, not switch
  });
});

describe("selectAdapter — rule 4: otherwise leave it for auto-dispatch to skip", () => {
  test("a rate-limited default with a non-portable task is left and marked skip", () => {
    const result = selectAdapter({
      labels: [],
      defaultAdapter: "claude",
      available: AVAILABLE,
      rateLimited: new Set(["claude"]),
      portable: false,
    });
    expect(result.adapter).toBe("claude");
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("not portable");
  });

  test("a portable task with no non-rate-limited alternative is left and marked skip", () => {
    const result = selectAdapter({
      labels: [],
      defaultAdapter: "claude",
      available: AVAILABLE,
      rateLimited: new Set(["claude", "codex"]),
      portable: true,
    });
    expect(result.adapter).toBe("claude");
    expect(result.skip).toBe(true);
  });

  test("a non-rate-limited choice is never marked skip", () => {
    const result = selectAdapter({
      labels: [],
      defaultAdapter: "claude",
      available: AVAILABLE,
      rateLimited: new Set(["codex"]),
    });
    expect(result.adapter).toBe("claude");
    expect(result.skip).toBe(false);
  });
});
