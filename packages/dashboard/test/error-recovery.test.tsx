/**
 * #223 loading skeletons + inline error recovery (DOM). The repo expansion is the
 * AC's integration target: a mocked loader throws on the first fetch → an inline
 * error panel with a working Retry renders → the retry resolves → the data renders.
 * Plus the distinct >10s network-timeout state ("Connection lost — retrying…").
 *
 * `.tsx` (not the AC's `.ts`) because it renders JSX. Runs under
 * `bun test packages/dashboard/`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import type { RepoDetail } from "../src/wire.ts";
import { flush, registerDom, renderDom, unregisterDom } from "./dom.tsx";

let RepoExpansion: (typeof import("../src/app/components/RepoExpansion.tsx"))["RepoExpansion"];
let useAsyncResource: (typeof import("../src/app/useAsyncResource.ts"))["useAsyncResource"];
let InlineError: (typeof import("../src/app/components/InlineError.tsx"))["InlineError"];
let createElement: typeof import("react").createElement;

beforeAll(async () => {
  registerDom();
  ({ RepoExpansion } = await import("../src/app/components/RepoExpansion.tsx"));
  ({ useAsyncResource } = await import("../src/app/useAsyncResource.ts"));
  ({ InlineError } = await import("../src/app/components/InlineError.tsx"));
  ({ createElement } = await import("react"));
});
afterAll(() => unregisterDom());

const detail: RepoDetail = {
  repo: "o/r",
  adapters: [],
  total: { used: 0, max: 1 },
  auto: true,
  nextUp: [{ rank: 1, epic: 99, adapter: "claude", subIssues: 3, reason: "top of ready" }],
  inFlight: [],
};

function retryButton(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Retry");
}

describe("#223 inline error recovery", () => {
  test("repo expansion: first fetch throws → error panel + Retry → retry resolves → data", async () => {
    let calls = 0;
    const loader = async () => {
      calls += 1;
      if (calls === 1) throw new Error("HTTP 500");
      return detail;
    };
    const { container, unmount } = await renderDom(<RepoExpansion loader={loader} />);
    await flush();

    // First load failed → inline alert with the message and a Retry button.
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("HTTP 500");
    const retry = retryButton(container);
    expect(retry).toBeTruthy();

    // Retry re-fires the loader (now resolving) → content replaces the error.
    await flush(() => retry!.click());
    await flush();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("NEXT UP");
    expect(container.textContent).toContain("top of ready");
    expect(calls).toBe(2);
    await unmount();
  });

  test("a >10s network timeout surfaces the distinct 'Connection lost' state", async () => {
    // A loader that never settles + a short timeout → status flips to "timeout".
    function Harness(): ReactElement {
      const r = useAsyncResource<RepoDetail>(() => new Promise(() => {}), { timeoutMs: 30 });
      return r.status === "timeout"
        ? createElement(InlineError, { timedOut: true, onRetry: () => {} })
        : createElement("span", null, "loading");
    }
    const { container, unmount } = await renderDom(createElement(Harness));
    await new Promise((r) => setTimeout(r, 60));
    await flush();
    expect(container.textContent).toContain("Connection lost — retrying…");
    await unmount();
  });
});
