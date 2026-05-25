import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Epics } from "../src/app/components/Epics.tsx";
import type { EpicCard } from "../src/wire.ts";

const card = (over: Partial<EpicCard> = {}): EpicCard => ({
  repo: "o/r", number: 247, title: "OAuth refresh",
  progress: { closed: 2, total: 4 },
  runner: null, decision: null,
  dispatch: { inFlight: false, recommendedAdapter: "claude", freeSlots: [{ adapter: "claude", available: true }] },
  ...over,
});
const html = (c: EpicCard) =>
  renderToStaticMarkup(<Epics epics={[c]} adapters={["claude"]} onDispatch={() => {}} onOpenInspector={() => {}} />);

describe("Epics", () => {
  test("renders an Epic card with title, progress, and an enabled dispatch button", () => {
    const out = html(card());
    expect(out).toContain("#247 OAuth refresh");
    expect(out).toContain("2 / 4");
    expect(out).toContain("dispatch");
    expect(out).not.toContain("disabled");
  });

  test("empty state when there are no Epics", () => {
    const out = renderToStaticMarkup(
      <Epics epics={[]} adapters={["claude"]} onDispatch={() => {}} onOpenInspector={() => {}} />,
    );
    expect(out).toContain("No open Epics for this repo.");
  });

  test("disables dispatch when in flight", () => {
    const out = html(card({
      dispatch: { inFlight: true, recommendedAdapter: "claude", freeSlots: [{ adapter: "claude", available: true }] },
      runner: { adapter: "claude", state: "running", currentSubIssue: 1, session: "s", prNumber: null },
    }));
    expect(out).toContain("disabled");
    expect(out).toContain("claude · running");
  });

  test("disables dispatch when the chosen adapter has no free slot", () => {
    const out = html(card({
      dispatch: { inFlight: false, recommendedAdapter: "claude", freeSlots: [{ adapter: "claude", available: false }] },
    }));
    expect(out).toContain("disabled");
  });

  test("shows a decision callout when present", () => {
    const out = html(card({ decision: { label: "awaiting reply", oneLiner: "answer the window question" } }));
    expect(out).toContain("awaiting reply");
    expect(out).toContain("answer the window question");
  });

  test("renders the decision link as an anchor when present", () => {
    const out = html(card({ decision: { label: "fork tied", oneLiner: "pick one", link: "http://x/1" } }));
    expect(out).toContain('href="http://x/1"');
  });
});
