/**
 * Inspector DOM tests (happy-dom). The Inspector is now a shadcn `Sheet` (Radix
 * Dialog), which portals its content into `document.body` — `renderToStaticMarkup`
 * drops portals, so these assertions run against a real DOM. Ported from the SSR
 * Inspector tests that previously lived in `app.test.tsx` / `epic-ref.test.tsx`,
 * plus the Sheet-shape assertions for #220 (Inspector opens as a Sheet, not a
 * fixed `<aside>`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RunnerPanel } from "../src/wire.ts";
import { registerDom, renderDom, unregisterDom } from "./dom.tsx";

// Import the component AFTER happy-dom registers (see dom.tsx) — a Radix Dialog
// imported before registration won't mount its portal.
let Inspector: (typeof import("../src/app/components/Inspector.tsx"))["Inspector"];
beforeAll(async () => {
  registerDom();
  ({ Inspector } = await import("../src/app/components/Inspector.tsx"));
});
afterAll(() => unregisterDom());

const panel = (over: Partial<RunnerPanel> = {}): RunnerPanel => ({
  session: "mm-alpha-247",
  workflowId: "w1",
  repo: "o/alpha",
  epic: 247,
  epicRef: null,
  adapter: "claude",
  state: "running",
  controlledBy: "middle",
  alive: true,
  lastHeartbeat: null,
  contextTokens: null,
  transcriptPath: "/wt/alpha/transcript.jsonl",
  worktreePath: "/wt/alpha",
  prNumber: 251,
  prBranch: "feat/oauth",
  currentSubIssue: 2,
  attachCommands: {
    watch: "tmux attach -r -t 'mm-alpha-247'",
    control: "tmux attach -t 'mm-alpha-247'",
  },
  ...over,
});

describe("Inspector (Sheet)", () => {
  test("opens as a Sheet (Radix Dialog) — data-slot sheet-content + role=dialog, not a fixed aside", async () => {
    const { unmount } = await renderDom(<Inspector panel={panel()} events={[]} />);
    const content = document.body.querySelector('[data-slot="sheet-content"]');
    expect(content).not.toBeNull();
    expect(content!.getAttribute("role")).toBe("dialog");
    expect(content!.getAttribute("aria-label")).toBe("Inspector for mm-alpha-247");
    // It is NOT the old fixed-position <aside class="inspector"> element.
    expect(document.body.querySelector("aside.inspector")).toBeNull();
    await unmount();
  });

  test("renders the per-runner panel, links, affordances, and timeline", async () => {
    const { unmount } = await renderDom(
      <Inspector
        panel={panel()}
        events={[
          { ts: 1000, type: "session.started", payload: null },
          { ts: 2000, type: "gate.passed", payload: null },
        ]}
        transcriptUrl="/api/sessions/mm-alpha-247/transcript"
      />,
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("controlled by");
    expect(text).toContain("● live");
    expect(text).toContain("#251"); // PR
    expect(text).toContain("/wt/alpha"); // worktree
    expect(text).toContain("tmux attach -t 'mm-alpha-247'"); // control copy command (unescaped in the DOM)
    expect(text).toContain("gate.passed"); // verification evidence + timeline
    expect(text).toContain("session.started");
    // The action affordances are shadcn Buttons.
    expect(document.body.querySelectorAll('[data-slot="button"]').length).toBeGreaterThan(0);
    await unmount();
  });

  test("file-mode panel shows the slug file:// link in the header", async () => {
    const { unmount } = await renderDom(
      <Inspector panel={panel({ epic: null, epicRef: "the-slug" })} events={[]} />,
    );
    const link = document.body.querySelector('a[href="file://planning/epics/the-slug.md"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain("the-slug");
    await unmount();
  });

  test("github-mode panel is unchanged (`#7`, no file:// link)", async () => {
    const { unmount } = await renderDom(
      <Inspector panel={panel({ epic: 7, epicRef: null })} events={[]} />,
    );
    expect(document.body.textContent).toContain("#7");
    expect(document.body.querySelector('a[href^="file://"]')).toBeNull();
    await unmount();
  });
});
