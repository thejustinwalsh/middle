/**
 * #222 responsive layout (happy-dom + a `matchMedia` viewport mock). Asserts the
 * observable behavior the AC names: at a 360×640 mobile viewport the Inspector
 * renders as a bottom-anchored, full-width Sheet; at a desktop viewport it anchors
 * right. The anchor edge is JS-driven (`useMediaQuery`), so it's testable here;
 * the pure-CSS responsive bits (nav→Sheet menu, repo expansions stacking) are
 * media-query rules verified visually by the Playwright smoke (#224).
 *
 * `.tsx` (not the AC's `.ts`) because it renders JSX — `.ts` parses `<Inspector>`
 * as a type assertion. Runs under `bun test packages/dashboard/` all the same.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RunnerPanel } from "../src/wire.ts";
import { registerDom, renderDom, unregisterDom } from "./dom.tsx";

let Inspector: (typeof import("../src/app/components/Inspector.tsx"))["Inspector"];

beforeAll(async () => {
  registerDom();
  ({ Inspector } = await import("../src/app/components/Inspector.tsx"));
});
afterAll(() => unregisterDom());

/** Point `window.matchMedia` at a fixed viewport width (parses `min-width: Npx`). */
function mockViewport(width: number): void {
  (window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (query: string) => {
    const m = query.match(/min-width:\s*(\d+)px/);
    const min = m ? Number(m[1]) : 0;
    return {
      matches: width >= min,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    };
  };
}

const panel: RunnerPanel = {
  session: "s1",
  workflowId: "w1",
  repo: "o/r",
  epic: 7,
  epicRef: null,
  adapter: "claude",
  state: "running",
  controlledBy: "middle",
  alive: true,
  lastHeartbeat: null,
  contextTokens: null,
  transcriptPath: null,
  worktreePath: null,
  prNumber: null,
  prBranch: null,
  currentSubIssue: null,
  attachCommands: { watch: "w", control: "c" },
};

describe("#222 responsive Inspector Sheet", () => {
  test("at 360×640 (mobile) the Inspector is a bottom-anchored, full-width Sheet", async () => {
    mockViewport(360);
    const { unmount } = await renderDom(<Inspector panel={panel} events={[]} />);
    const content = document.body.querySelector('[data-slot="sheet-content"]')!;
    expect(content).not.toBeNull();
    const cls = content.className;
    expect(cls).toContain("bottom-0"); // anchored to the bottom edge
    expect(cls).toContain("inset-x-0"); // full-width
    expect(cls).not.toContain("inset-y-0"); // NOT the right-edge anchor
    await unmount();
  });

  test("at a desktop viewport (≥1024) the Inspector anchors to the right edge", async () => {
    mockViewport(1280);
    const { unmount } = await renderDom(<Inspector panel={panel} events={[]} />);
    const cls = document.body.querySelector('[data-slot="sheet-content"]')!.className;
    expect(cls).toContain("right-0");
    expect(cls).toContain("inset-y-0");
    expect(cls).not.toContain("bottom-0");
    await unmount();
  });
});
