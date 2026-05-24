import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PrReadyGateHandler } from "../src/gates/pr-ready-handler.ts";
import { HookServer } from "../src/hook-server.ts";

let server: HookServer;

function startWithGate(gate: PrReadyGateHandler): void {
  server = new HookServer(undefined, gate);
  server.start(0);
}

afterEach(() => {
  server?.stop();
});

async function postGate(payload: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/gates/pr-ready`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Middle-Session": "middle-27" },
    body: JSON.stringify(payload),
  });
}

describe("HookServer — /gates/pr-ready", () => {
  test("returns 200 when the gate allows", async () => {
    startWithGate(async () => ({ decision: "allow" }));
    const res = await postGate({ tool_input: { command: "gh pr ready" } });
    expect(res.status).toBe(200);
  });

  test("returns 403 with the reason in the body when the gate denies", async () => {
    startWithGate(async () => ({ decision: "deny", reason: "criteria X and Y lack evidence" }));
    const res = await postGate({ tool_input: { command: "gh pr ready" } });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("criteria X and Y lack evidence");
  });

  test("forwards the session name and payload to the gate handler", async () => {
    const seen: Array<{ sessionName: string; command: unknown }> = [];
    startWithGate(async ({ sessionName, payload }) => {
      seen.push({ sessionName, command: (payload.tool_input as { command?: unknown })?.command });
      return { decision: "allow" };
    });
    await postGate({ tool_input: { command: "gh pr ready 86" } });
    expect(seen[0]).toEqual({ sessionName: "middle-27", command: "gh pr ready 86" });
  });

  test("404s the gate route when no gate handler is wired", async () => {
    server = new HookServer();
    server.start(0);
    const res = await postGate({ tool_input: { command: "gh pr ready" } });
    expect(res.status).toBe(404);
  });
});
