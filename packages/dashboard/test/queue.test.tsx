import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Queue } from "../src/app/components/Queue.tsx";

test("Queue renders totals and in-flight rows from a metrics snapshot", () => {
  const html = renderToStaticMarkup(
    <Queue
      metrics={{
        workflows: [{ repo: "o/r", kind: "implementation", state: "running", count: 2 }],
        rateLimits: [],
        slots: { total: 2 },
        totals: { all: 2, active: 2, waitingHuman: 0 },
      }}
      live={[{ id: "w1", repo: "o/r", epic: 7, state: "running" }]}
    />,
  );
  expect(html).toContain("o/r");
  expect(html).toContain("running");
});

test("Queue shows an empty state with no data", () => {
  const html = renderToStaticMarkup(<Queue metrics={null} live={[]} />);
  expect(html).toContain("no data yet");
});
