import { describe, expect, test } from "bun:test";
import { type GuardError, makeGuard } from "../src/app/guard.ts";

// `makeGuard` is the SPA's async-error funnel. These tests pin the source-keying
// semantics and — the regression this guards — the nested-same-source masking
// that let a failed inspector refresh disappear behind the outer guard's
// success path (PR #138 review round 2).

// A stand-in for React's `setError` that applies the functional-or-value update
// and records the resulting error, so assertions read the latest state.
function fakeSetError(): {
  set: (u: GuardError | null | ((cur: GuardError | null) => GuardError | null)) => void;
  current: () => GuardError | null;
} {
  let cur: GuardError | null = null;
  return {
    set: (u) => {
      cur = typeof u === "function" ? u(cur) : u;
    },
    current: () => cur,
  };
}

describe("makeGuard", () => {
  test("surfaces a rejection as an error keyed by source", async () => {
    const store = fakeSetError();
    const guard = makeGuard(store.set);
    await guard("inspector", async () => {
      throw new Error("boom");
    });
    expect(store.current()).toEqual({ source: "inspector", message: "boom" });
  });

  test("a non-Error rejection is stringified", async () => {
    const store = fakeSetError();
    const guard = makeGuard(store.set);
    await guard("inspector", async () => {
      throw "plain string";
    });
    expect(store.current()).toEqual({ source: "inspector", message: "plain string" });
  });

  test("success clears only its own source's error, never another source's", async () => {
    const store = fakeSetError();
    const guard = makeGuard(store.set);

    await guard("settings", async () => {
      throw new Error("settings down");
    });
    expect(store.current()?.source).toBe("settings");

    // A healthy poll on a *different* source must not wipe the live settings error.
    await guard("top", async () => {});
    expect(store.current()).toEqual({ source: "settings", message: "settings down" });

    // A success on the *same* source clears it.
    await guard("settings", async () => {});
    expect(store.current()).toBeNull();
  });

  test("REGRESSION: a nested same-source guard masks the inner failure", async () => {
    const store = fakeSetError();
    const guard = makeGuard(store.set);

    // The old `takeControl`/`release` shape: a guarded op that awaited a *second*
    // guard of the same source. The inner guard catches the failure (setting the
    // error), then the outer guard completes successfully and its success path
    // clears that very error — so nothing surfaces. This is the bug.
    await guard("inspector", async () => {
      await guard("inspector", async () => {
        throw new Error("refresh failed");
      });
    });
    expect(store.current()).toBeNull();
  });

  test("FIX: awaiting raw work inside one guard surfaces the failure", async () => {
    const store = fakeSetError();
    const guard = makeGuard(store.set);

    // The fixed shape: the outer guard awaits the *raw* sub-step (like
    // `loadInspector`), so a sub-step failure propagates to the single guard and
    // is surfaced rather than swallowed.
    const loadInspector = async () => {
      throw new Error("refresh failed");
    };
    await guard("inspector", async () => {
      await loadInspector();
    });
    expect(store.current()).toEqual({ source: "inspector", message: "refresh failed" });
  });
});
