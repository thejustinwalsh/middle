/**
 * Repo expansion happy-path (DOM). The expansion body self-fetches its detail
 * (RepoExpansion → useAsyncResource), so the NEXT UP / IN FLIGHT content only
 * appears after the loader resolves — a real DOM is needed (the SSR header-only
 * assertions live in `app.test.tsx`). Error / retry / timeout states are in
 * `error-recovery.test.tsx`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RepoDetail, RepoSummary } from "../src/wire.ts";
import { flush, registerDom, renderDom, unregisterDom } from "./dom.tsx";

let RepoRow: (typeof import("../src/app/components/Repos.tsx"))["RepoRow"];

beforeAll(async () => {
  registerDom();
  ({ RepoRow } = await import("../src/app/components/Repos.tsx"));
});
afterAll(() => unregisterDom());

const summary: RepoSummary = {
  repo: "o/alpha",
  adapters: [{ adapter: "claude", used: 2, max: 2 }],
  total: { used: 2, max: 3 },
  auto: true,
};

const detail: RepoDetail = {
  repo: "o/alpha",
  adapters: [{ adapter: "claude", used: 2, max: 2 }],
  total: { used: 2, max: 3 },
  auto: true,
  nextUp: [{ rank: 1, epic: 247, adapter: "claude", subIssues: 4, reason: "top of ready" }],
  inFlight: [
    {
      session: "mm-alpha-247",
      workflowId: "w1",
      epic: 247,
      epicRef: null,
      adapter: "claude",
      progress: "sub-issue 2",
      state: "running",
      controlledBy: "human",
      lastHeartbeat: null,
      attachCommands: {
        watch: "tmux attach -r -t 'mm-alpha-247'",
        control: "tmux attach -t 'mm-alpha-247'",
      },
    },
  ],
};

describe("RepoRow expansion (happy path)", () => {
  test("an expanded row loads + renders NEXT UP, IN FLIGHT, and the attach command", async () => {
    const { container, unmount } = await renderDom(
      <RepoRow summary={summary} expanded loadDetail={async () => detail} onToggle={() => {}} />,
    );
    await flush(); // let the resolved loader settle into content
    const text = container.textContent ?? "";
    expect(text).toContain("NEXT UP");
    expect(text).toContain("top of ready"); // nextUp reason
    expect(text).toContain("IN FLIGHT");
    expect(text).toContain("human"); // controlled_by badge
    expect(text).toContain("tmux attach -r -t 'mm-alpha-247'"); // copy command (unescaped in DOM)
    await unmount();
  });
});
