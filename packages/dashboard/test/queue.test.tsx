import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Queue } from "../src/app/components/Queue.tsx";

const baseMetrics = {
  workflows: [{ repo: "o/r", kind: "implementation", state: "running", count: 2 }],
  rateLimits: [],
  slots: { total: 2 },
  totals: { all: 2, active: 2, waitingHuman: 0 },
};

test("Queue shows an empty state with no data", () => {
  const html = renderToStaticMarkup(<Queue metrics={null} live={[]} />);
  expect(html).toContain("no data yet");
});

test("Queue renders nothing-in-flight row when live is empty", () => {
  const html = renderToStaticMarkup(<Queue metrics={baseMetrics} live={[]} />);
  expect(html).toContain("nothing in flight");
});

test("Queue renders gauge tile labels and values from totals", () => {
  const html = renderToStaticMarkup(
    <Queue
      metrics={{ ...baseMetrics, totals: { all: 2, active: 2, waitingHuman: 0 } }}
      live={[]}
    />,
  );
  // labels
  expect(html).toContain("Active");
  expect(html).toContain("Waiting for you");
  expect(html).toContain("Total workflows");
  // values: all=2, active=2, waitingHuman=0
  // "2" appears multiple times; just confirm the zero for waitingHuman rounds off the set
  expect(html).toContain(">2<");
  expect(html).toContain(">0<");
});

test("Queue renders epic as #N for a numeric epic and — for null", () => {
  const html = renderToStaticMarkup(
    <Queue
      metrics={baseMetrics}
      live={[
        { id: "w1", repo: "o/r", epic: 7, state: "running" },
        { id: "w2", repo: "o/r2", epic: null, state: "running" },
      ]}
    />,
  );
  expect(html).toContain("#7");
  // "—" is the em-dash rendered for null epic
  expect(html).toContain("—");
});

test("Queue state cell carries the s-running class", () => {
  const html = renderToStaticMarkup(
    <Queue metrics={baseMetrics} live={[{ id: "w1", repo: "o/r", epic: 7, state: "running" }]} />,
  );
  expect(html).toContain("s-running");
});

test("Queue renders rate-limit chip with adapter name, status, and chip class", () => {
  const html = renderToStaticMarkup(
    <Queue
      metrics={{
        ...baseMetrics,
        rateLimits: [{ adapter: "claude", status: "RATE_LIMITED" }],
      }}
      live={[]}
    />,
  );
  expect(html).toContain("c-rate_limited");
  expect(html).toContain("claude");
  expect(html).toContain("RATE_LIMITED");
});

test("Queue sorts waiting-human rows before running rows", () => {
  const html = renderToStaticMarkup(
    <Queue
      metrics={baseMetrics}
      live={[
        { id: "w1", repo: "running-repo", epic: 1, state: "running" },
        { id: "w2", repo: "waiting-repo", epic: 2, state: "waiting-human" },
      ]}
    />,
  );
  const waitingPos = html.indexOf("waiting-repo");
  const runningPos = html.indexOf("running-repo");
  expect(waitingPos).toBeGreaterThanOrEqual(0);
  expect(runningPos).toBeGreaterThanOrEqual(0);
  expect(waitingPos).toBeLessThan(runningPos);
});
