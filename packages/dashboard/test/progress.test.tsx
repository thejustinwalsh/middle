/**
 * The shadcn Progress primitive sanitizes its `value` before deriving the
 * indicator transform (CodeRabbit, PR #231): a non-finite or out-of-range value
 * must never produce invalid/visually-broken CSS. The transform is
 * `translateX(-(100 - clamped)%)`, so 0 → -100%, 100 → -0%.
 */
import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Progress } from "../src/app/components/ui/progress.tsx";

function transformOf(value: number | undefined): string {
  const html = renderToStaticMarkup(<Progress value={value} />);
  const m = html.match(/translateX\(-[\d.]+%\)/);
  if (!m) throw new Error(`no translateX in: ${html}`);
  return m[0];
}

test("in-range value maps straight through", () => {
  expect(transformOf(0)).toBe("translateX(-100%)");
  expect(transformOf(50)).toBe("translateX(-50%)");
  expect(transformOf(100)).toBe("translateX(-0%)");
});

test("above 100 clamps to 100 (full bar), not a positive translate", () => {
  expect(transformOf(150)).toBe("translateX(-0%)");
});

test("below 0 clamps to 0 (empty bar)", () => {
  expect(transformOf(-10)).toBe("translateX(-100%)");
});

test("NaN / Infinity / undefined fall back to 0 (empty bar), never NaN%", () => {
  expect(transformOf(Number.NaN)).toBe("translateX(-100%)");
  expect(transformOf(Number.POSITIVE_INFINITY)).toBe("translateX(-100%)");
  expect(transformOf(undefined)).toBe("translateX(-100%)");
});

test("out-of-range / non-finite values don't trip Radix's own range warning", () => {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const v of [150, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      renderToStaticMarkup(<Progress value={v} />);
    }
    const warned = spy.mock.calls.flat().join(" ");
    expect(warned).not.toContain("Invalid prop");
  } finally {
    spy.mockRestore();
  }
});
