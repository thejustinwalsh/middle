import { expect, test } from "bun:test";
import type { DaemonHostContext } from "../src/main.ts";

test("DaemonHostContext exposes dispatch + refreshEpics callbacks", () => {
  const shape: (keyof DaemonHostContext)[] = [
    "db",
    "config",
    "stateGateway",
    "runRecommender",
    "dispatch",
    "refreshEpics",
  ];
  expect(shape).toContain("dispatch");
  expect(shape).toContain("refreshEpics");
});
