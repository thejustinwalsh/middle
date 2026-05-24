import { describe, expect, test } from "bun:test";
import {
  type CheckboxReconcileDeps,
  type GateRunResult,
  parseStatusCheckboxes,
  reconcileCheckboxes,
} from "../../src/gates/checkbox-revert.ts";

const BODY = `## Summary
Closes #27

## Status
- [ ] #28 — Plan-comment guard
- [x] #29 — PR-ready guard
- [ ] #30 — Checkbox-revert reconciler

## Notes
- [ ] not a sub-issue line, ignored
`;

describe("parseStatusCheckboxes", () => {
  test("extracts one entry per Status line carrying a #N reference, stopping at the next heading", () => {
    expect(parseStatusCheckboxes(BODY)).toEqual([
      { subIssue: 28, checked: false },
      { subIssue: 29, checked: true },
      { subIssue: 30, checked: false },
    ]);
  });

  test("returns [] when there is no Status section", () => {
    expect(parseStatusCheckboxes("## Summary\nnothing\n")).toEqual([]);
  });

  test("a lookalike heading (## Status notes) does not shadow the real ## Status", () => {
    const body = `## Status notes
- [x] #99 — not the real status section
## Status
- [x] #30 — the real one
`;
    expect(parseStatusCheckboxes(body)).toEqual([{ subIssue: 30, checked: true }]);
  });

  test("only a level-2 ## Status heading starts the section (# / ### Status ignored)", () => {
    const body = `# Status
- [x] #97 — h1, ignored
### Status
- [x] #98 — h3, ignored
## Status
- [x] #30 — the real one
`;
    expect(parseStatusCheckboxes(body)).toEqual([{ subIssue: 30, checked: true }]);
  });

  test("a ## Status / checkbox inside a fenced code block does not shadow the real section", () => {
    const body = [
      "## Summary",
      "```",
      "## Status",
      "- [x] #99 — example in a fence",
      "```",
      "## Status",
      "- [x] #30 — real",
      "",
    ].join("\n");
    expect(parseStatusCheckboxes(body)).toEqual([{ subIssue: 30, checked: true }]);
  });

  test("mixed fence delimiters: a ~~~ inside a ``` block does not reopen real parsing", () => {
    // Without matching-delimiter tracking, the inner ~~~ flips the fence state,
    // so the fenced `## Status`/checkbox below it gets parsed as the real one.
    const body = [
      "## Summary",
      "```",
      "~~~",
      "## Status",
      "- [x] #99 — fenced example, must not be parsed",
      "```",
      "## Status",
      "- [x] #30 — the real one",
      "",
    ].join("\n");
    expect(parseStatusCheckboxes(body)).toEqual([{ subIssue: 30, checked: true }]);
  });

  test("only the FIRST ## Status section is parsed; a later one is ignored", () => {
    const body = `## Status
- [x] #28 — first section
## Other
text
## Status
- [x] #29 — a second status block, out of scope
`;
    expect(parseStatusCheckboxes(body)).toEqual([{ subIssue: 28, checked: true }]);
  });
});

/** A recording harness over the reconciler's seams. */
function harness(opts: {
  body: string;
  previous: Record<number, boolean>;
  gates: (subIssue: number) => GateRunResult;
}) {
  const state = { body: opts.body, previous: { ...opts.previous } };
  const comments: string[] = [];
  const ran: number[] = [];
  const deps: CheckboxReconcileDeps = {
    async getPrBody() {
      return state.body;
    },
    async setPrBody(body) {
      state.body = body;
    },
    async postComment(body) {
      comments.push(body);
    },
    async runGates(subIssue) {
      ran.push(subIssue);
      return opts.gates(subIssue);
    },
    async getPreviousState() {
      return state.previous;
    },
    async setPreviousState(s) {
      state.previous = s;
    },
  };
  return { state, comments, ran, deps };
}

describe("reconcileCheckboxes", () => {
  const STATUS = `## Status
- [x] #30 — Checkbox-revert reconciler
`;

  test("a passing [ ]→[x] transition is left checked, no comment, state recorded", async () => {
    const h = harness({ body: STATUS, previous: { 30: false }, gates: () => ({ ok: true }) });
    const result = await reconcileCheckboxes(h.deps);

    expect(result.reverted).toEqual([]);
    expect(h.ran).toEqual([30]);
    expect(h.state.body).toContain("- [x] #30");
    expect(h.comments).toEqual([]);
    expect(h.state.previous[30]).toBe(true);
  });

  test("a failing [ ]→[x] transition is reverted and a comment names the failed gate", async () => {
    const h = harness({
      body: STATUS,
      previous: { 30: false },
      gates: () => ({ ok: false, failedGate: "typecheck" }),
    });
    const result = await reconcileCheckboxes(h.deps);

    expect(result.reverted).toEqual([30]);
    expect(h.state.body).toContain("- [ ] #30");
    expect(h.state.body).not.toContain("- [x] #30");
    expect(h.comments.length).toBe(1);
    expect(h.comments[0]).toContain("#30");
    expect(h.comments[0]).toContain("typecheck");
    // recorded as unchecked so the next push doesn't re-treat it as a transition
    expect(h.state.previous[30]).toBe(false);
  });

  test("a box already checked on the previous pass is not re-run", async () => {
    const h = harness({ body: STATUS, previous: { 30: true }, gates: () => ({ ok: true }) });
    const result = await reconcileCheckboxes(h.deps);

    expect(h.ran).toEqual([]);
    expect(result.reverted).toEqual([]);
    expect(h.state.body).toContain("- [x] #30");
  });

  test("a revert touches only the Status section, not the same #N checkbox elsewhere", async () => {
    const body = `## Status
- [x] #30 — Checkbox-revert reconciler

## Related work
- [x] #30 — tracked elsewhere, must NOT be reverted
`;
    const h = harness({
      body,
      previous: { 30: false },
      gates: () => ({ ok: false, failedGate: "typecheck" }),
    });
    await reconcileCheckboxes(h.deps);

    // the Status box is reverted...
    const statusPart = h.state.body.split("## Related work")[0]!;
    expect(statusPart).toContain("- [ ] #30");
    // ...but the identical #30 reference under another heading is left untouched
    expect(h.state.body).toContain("## Related work\n- [x] #30 — tracked elsewhere");
  });

  test("with several transitions, only the failing sub-issue is reverted", async () => {
    const body = `## Status
- [x] #28 — Plan-comment guard
- [x] #30 — Checkbox-revert reconciler
`;
    const h = harness({
      body,
      previous: { 28: false, 30: false },
      gates: (n) => (n === 30 ? { ok: false, failedGate: "test" } : { ok: true }),
    });
    const result = await reconcileCheckboxes(h.deps);

    expect(result.reverted).toEqual([30]);
    expect(h.state.body).toContain("- [x] #28");
    expect(h.state.body).toContain("- [ ] #30");
    expect(h.state.previous).toEqual({ 28: true, 30: false });
  });
});
