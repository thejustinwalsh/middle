/**
 * #221 focus-visible + keyboard-reachability (happy-dom). Asserts the observable
 * behavior: every focusable element on the Epics view is reachable (receives
 * focus, i.e. is in the tab order) and the shadcn primitives carry a
 * `focus-visible:ring` so the focus indicator is never invisible — across the
 * Tabs/Button/Select/Input/Collapsible-trigger primitives the AC names.
 *
 * happy-dom (like jsdom) doesn't move focus on a synthetic Tab keypress, so we
 * focus each focusable in DOM order and assert it becomes `activeElement` — the
 * jsdom-feasible stand-in for tabbing. Real keyboard Tab traversal + the painted
 * ring are exercised in the Playwright smoke (#224).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EpicCard } from "../src/wire.ts";
import { registerDom, renderDom, unregisterDom } from "./dom.tsx";

type Mod = typeof import("../src/app/components/Epics.tsx");
let Epics: Mod["Epics"];
let Button: (typeof import("../src/app/components/ui/button.tsx"))["Button"];
let ui: typeof import("../src/app/components/ui/tabs.tsx");
let Input: (typeof import("../src/app/components/ui/input.tsx"))["Input"];
let collapsible: typeof import("../src/app/components/ui/collapsible.tsx");

beforeAll(async () => {
  registerDom();
  ({ Epics } = await import("../src/app/components/Epics.tsx"));
  ({ Button } = await import("../src/app/components/ui/button.tsx"));
  ui = await import("../src/app/components/ui/tabs.tsx");
  ({ Input } = await import("../src/app/components/ui/input.tsx"));
  collapsible = await import("../src/app/components/ui/collapsible.tsx");
});
afterAll(() => unregisterDom());

const card = (over: Partial<EpicCard> = {}): EpicCard => ({
  repo: "o/r",
  ref: "247",
  number: 247,
  title: "OAuth refresh",
  progress: { closed: 2, total: 4 },
  runner: {
    adapter: "claude",
    state: "running",
    currentSubIssue: 1,
    session: "s1",
    prNumber: null,
  },
  decision: { label: "fork tied", oneLiner: "pick one", link: "http://x/1" },
  dispatch: {
    inFlight: false,
    recommendedAdapter: "claude",
    freeSlots: [{ adapter: "claude", available: true }],
  },
  ...over,
});

/**
 * Genuinely tab-reachable elements, in DOM order: enabled buttons/inputs and the
 * Radix tab/combobox triggers. Excludes disabled controls (not in the tab order),
 * `aria-hidden`, and `tabindex="-1"` (e.g. Radix Select's hidden native select).
 */
function focusables(): HTMLElement[] {
  const sel = 'button:not([disabled]), input:not([disabled]), [role="tab"], [role="combobox"]';
  return [...document.body.querySelectorAll<HTMLElement>(sel)].filter(
    (el) => el.getAttribute("tabindex") !== "-1" && el.getAttribute("aria-hidden") !== "true",
  );
}

describe("#221 focus-visible + keyboard reachability", () => {
  test("every focusable on the Epics view is reachable (in tab order)", async () => {
    const { unmount } = await renderDom(
      <Epics
        epics={[card(), card({ number: null, ref: "the-slug", runner: null, decision: null })]}
        adapters={["claude", "codex"]}
        onDispatch={() => {}}
        onOpenInspector={() => {}}
      />,
    );
    const els = focusables();
    expect(els.length).toBeGreaterThan(0);
    for (const el of els) {
      el.focus();
      // Compare as a boolean — never `toBe(el)`, which would serialize the entire
      // happy-dom node on a mismatch (catastrophically slow).
      expect(document.activeElement === el).toBe(true);
    }
    // The shadcn primitives on this view paint a focus ring on :focus-visible.
    for (const p of document.body.querySelectorAll(
      '[data-slot="button"], [data-slot="select-trigger"]',
    )) {
      expect(p.className).toContain("focus-visible:ring");
    }
    await unmount();
  });

  test("the AC's primitives each carry a focus-visible ring (Tabs/Button/Input/Collapsible trigger)", async () => {
    const { unmount } = await renderDom(
      <div>
        <ui.Tabs value="a">
          <ui.TabsList>
            <ui.TabsTrigger value="a">a</ui.TabsTrigger>
          </ui.TabsList>
        </ui.Tabs>
        <Input />
        <collapsible.Collapsible open>
          <collapsible.CollapsibleTrigger asChild>
            <Button>toggle</Button>
          </collapsible.CollapsibleTrigger>
        </collapsible.Collapsible>
      </div>,
    );
    expect(document.body.querySelector('[data-slot="tabs-trigger"]')!.className).toContain(
      "focus-visible:ring",
    );
    expect(document.body.querySelector('[data-slot="input"]')!.className).toContain(
      "focus-visible:ring",
    );
    // The repo collapsible trigger is a Button (asChild) → carries the ring.
    const trigger = document.body.querySelector('[data-slot="collapsible-trigger"]')!;
    expect(trigger.className).toContain("focus-visible:ring");
    await unmount();
  });
});
