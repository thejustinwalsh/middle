import { describe, expect, test } from "bun:test";
import { makePrReadyGateHandler, type PrReadyGateDeps } from "../../src/gates/pr-ready-handler.ts";

const EVIDENCED = "## Acceptance criteria\n- [ ] done (https://example.com/x)\n";
const UNEVIDENCED = "## Acceptance criteria\n- [ ] not done yet, no evidence\n";

function deps(over: Partial<PrReadyGateDeps>): PrReadyGateDeps {
  return {
    resolveSession: () => ({ repo: "o/r", epicNumber: 27 }),
    findEpicPr: async () => ({ body: EVIDENCED }),
    resolveCommentAuthor: async () => ({ login: "human", isBot: false }),
    ...over,
  };
}

describe("pr-ready gate handler", () => {
  test("allows a non-`gh pr ready` command without touching GitHub", async () => {
    let touched = false;
    const handler = makePrReadyGateHandler(
      deps({
        findEpicPr: async () => {
          touched = true;
          return null;
        },
      }),
    );
    const result = await handler({
      sessionName: "s",
      payload: { tool_input: { command: "ls -la" } },
    });
    expect(result).toEqual({ decision: "allow" });
    expect(touched).toBe(false);
  });

  test("allows when the Epic PR's criteria are all evidenced", async () => {
    const handler = makePrReadyGateHandler(deps({ findEpicPr: async () => ({ body: EVIDENCED }) }));
    const result = await handler({
      sessionName: "s",
      payload: { tool_input: { command: "gh pr ready 86" } },
    });
    expect(result).toEqual({ decision: "allow" });
  });

  test("denies when the Epic PR has unevidenced criteria", async () => {
    const handler = makePrReadyGateHandler(
      deps({ findEpicPr: async () => ({ body: UNEVIDENCED }) }),
    );
    const result = await handler({
      sessionName: "s",
      payload: { tool_input: { command: "gh pr ready" } },
    });
    expect(result.decision).toBe("deny");
  });

  test("denies when no open Epic PR can be found", async () => {
    const handler = makePrReadyGateHandler(deps({ findEpicPr: async () => null }));
    const result = await handler({
      sessionName: "s",
      payload: { tool_input: { command: "gh pr ready" } },
    });
    expect(result.decision).toBe("deny");
    if (result.decision === "deny") expect(result.reason).toContain("Epic PR");
  });

  test("denies when the session maps to no active workflow", async () => {
    const handler = makePrReadyGateHandler(deps({ resolveSession: () => null }));
    const result = await handler({
      sessionName: "ghost",
      payload: { tool_input: { command: "gh pr ready" } },
    });
    expect(result.decision).toBe("deny");
  });
});
