import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Activity } from "../src/app/components/Activity.tsx";
import type { RunSummary } from "../src/wire.ts";

const run = (over: Partial<RunSummary> = {}): RunSummary => ({
  workflowId: "rec1", kind: "recommender", repo: "o/r", state: "completed",
  session: "s-rec", startedAt: 1000, updatedAt: 4000, durationMs: 3000,
  active: false, hasTranscript: true, outputLink: "https://github.com/o/r/issues/84",
  ...over,
});
const html = (runs: RunSummary[]) =>
  renderToStaticMarkup(<Activity runs={runs} now={5000} onOpenInspector={() => {}} />);

describe("Activity", () => {
  test("renders Recommender and Documentation sections", () => {
    const out = html([run(), run({ workflowId: "doc1", kind: "documentation", outputLink: null })]);
    expect(out).toContain("Recommender");
    expect(out).toContain("Documentation");
    expect(out).toContain("o/r");
  });

  test("shows an output link when present and omits it otherwise", () => {
    const out = html([run()]);
    expect(out).toContain('href="https://github.com/o/r/issues/84"');
    const noLink = html([run({ outputLink: null })]);
    expect(noLink).not.toContain("<a ");
  });

  test("empty state per section when no runs of that kind", () => {
    const out = html([run({ kind: "recommender" })]); // no documentation runs
    expect(out).toContain("No documentation runs yet.");
  });

  test("renders a state label for each run", () => {
    const out = html([run({ state: "failed", active: false })]);
    expect(out).toContain("failed");
  });

  test("state pill tone: completed is ok, compensated/failed are bad", () => {
    expect(html([run({ state: "completed", active: false })])).toContain('class="run-state ok"');
    expect(html([run({ state: "compensated", active: false })])).toContain('class="run-state bad"');
    expect(html([run({ state: "running", active: true })])).toContain('class="run-state active"');
  });
});
