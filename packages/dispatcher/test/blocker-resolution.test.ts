import { describe, expect, test } from "bun:test";
import { parseStateIssue, renderStateIssue } from "@middle/state-issue";
import type { ParsedState } from "@middle/state-issue";
import {
  parseBlockerRef,
  resolveBlockers,
  type BlockerResolver,
  type IssueState,
} from "../src/blocker-resolution.ts";

// A minimal valid state body with one Ready row and a configurable Blocked list.
function bodyWith(opts: { ready?: string[]; blocked?: string[] }): string {
  const ready =
    opts.ready && opts.ready.length > 0
      ? opts.ready.join("\n")
      : "| — | _no Epics ready_ | — | — | — |";
  const blocked = opts.blocked && opts.blocked.length > 0 ? opts.blocked.join("\n") : "";
  return [
    "<!-- AGENT-QUEUE-STATE v1 -->",
    "<!-- generated: 2026-06-04T00:00:00Z · run: abcdef12 · interval: 60m -->",
    "<!-- owners: recommender=full-body, dispatcher=in-flight,rate-limits,slot-usage -->",
    "",
    "## Ready to dispatch",
    "",
    "| Rank | Epic | Adapter | Sub-issues | Reason |",
    "| --- | --- | --- | --- | --- |",
    ready,
    "",
    "## Needs human input",
    "",
    "## Blocked",
    ...(blocked ? ["", blocked] : []),
    "",
    "## In-flight",
    "",
    "- _no agents in flight_",
    "",
    "## Excluded",
    "",
    "## Rate limits",
    "",
    "- claude: AVAILABLE",
    "- codex: AVAILABLE",
    "- github: UNKNOWN",
    "",
    "## Slot usage",
    "",
    "- claude: 0/2",
    "- total: 0/2",
    "- global: 0/4",
    "",
    "<!-- /AGENT-QUEUE-STATE -->",
  ].join("\n");
}

function parse(body: string): ParsedState {
  const p = parseStateIssue(body);
  if ("kind" in p) throw new Error(`fixture body did not parse: ${p.message}`);
  return p;
}

/** A resolver backed by an in-memory issue table keyed by "repo#n". */
function resolverFrom(
  table: Record<string, IssueState>,
  over: Partial<BlockerResolver> = {},
): BlockerResolver {
  return {
    repo: over.repo ?? "acme/a",
    defaultAdapter: over.defaultAdapter ?? "claude",
    resolveIssue: async (repo, issue) => table[`${repo}#${issue}`] ?? null,
    selfEpic: over.selfEpic,
  };
}

describe("parseBlockerRef", () => {
  test("same-repo #<n>", () => {
    expect(parseBlockerRef("#42")).toEqual({ kind: "same-repo", issue: 42, ref: "#42" });
  });

  test("cross-repo <owner>/<repo>#<n>", () => {
    expect(parseBlockerRef("acme/b#7")).toEqual({
      kind: "cross-repo",
      repo: "acme/b",
      issue: 7,
      ref: "acme/b#7",
    });
  });

  test("strips a trailing title annotation when extracting the ref", () => {
    expect(parseBlockerRef("#42 (Add auth)")).toEqual({ kind: "same-repo", issue: 42, ref: "#42" });
    expect(parseBlockerRef("acme/b#7 (stale blocker: acme/b#7)")).toEqual({
      kind: "cross-repo",
      repo: "acme/b",
      issue: 7,
      ref: "acme/b#7",
    });
  });

  test("backticked non-issue blocker is non-resolvable", () => {
    expect(parseBlockerRef("`upstream library release`")).toEqual({ kind: "non-issue" });
  });

  test("free text without a #<n> is non-issue", () => {
    expect(parseBlockerRef("database migration")).toEqual({ kind: "non-issue" });
  });
});

describe("resolveBlockers", () => {
  test("a closed same-repo blocker moves the item to Ready to dispatch", async () => {
    const state = parse(bodyWith({ blocked: ["- **#10** waiting on #42 · needs the auth epic"] }));
    const next = await resolveBlockers(
      state,
      resolverFrom(
        { "acme/a#42": { state: "closed", title: "Auth epic" } },
        { selfEpic: (n) => (n === 10 ? { title: "Dashboard epic", openSubIssues: 3 } : undefined) },
      ),
    );
    expect(next.blocked).toEqual([]);
    expect(next.readyToDispatch).toHaveLength(1);
    const row = next.readyToDispatch[0]!;
    expect(row.rank).toBe(1);
    expect(row.epic).toBe("#10 Dashboard epic");
    expect(row.adapter).toBe("claude");
    expect(row.subIssues).toBe(3);
    expect(row.reason).toContain("#42");
  });

  test("an open blocker stays Blocked, annotated with the resolved title", async () => {
    const state = parse(bodyWith({ blocked: ["- **#10** waiting on acme/b#7 · cross-repo dep"] }));
    const next = await resolveBlockers(
      state,
      resolverFrom({ "acme/b#7": { state: "open", title: "Repo B epic" } }),
    );
    expect(next.readyToDispatch).toEqual([]);
    expect(next.blocked).toHaveLength(1);
    expect(next.blocked[0]!.blocker).toBe("acme/b#7 (Repo B epic)");
    expect(next.blocked[0]!.context).toBe("cross-repo dep");
  });

  test("an unresolvable (404) blocker stays Blocked with a (stale blocker: <ref>) suffix", async () => {
    const state = parse(bodyWith({ blocked: ["- **#10** waiting on acme/b#999 · gone"] }));
    const next = await resolveBlockers(state, resolverFrom({}));
    expect(next.blocked).toHaveLength(1);
    expect(next.blocked[0]!.blocker).toBe("acme/b#999 (stale blocker: acme/b#999)");
  });

  test("a backticked non-issue blocker is left untouched", async () => {
    const state = parse(
      bodyWith({ blocked: ["- **#10** waiting on `upstream release` · external"] }),
    );
    const next = await resolveBlockers(state, resolverFrom({}));
    expect(next.blocked[0]!.blocker).toBe("`upstream release`");
  });

  test("an open blocker with an empty title falls back to the bare ref (never `#42 ()`)", async () => {
    // Regression: `#42 ()` would fail the `validate` the verify step runs next.
    const state = parse(bodyWith({ blocked: ["- **#10** waiting on acme/b#7 · dep"] }));
    const next = await resolveBlockers(
      state,
      resolverFrom({ "acme/b#7": { state: "open", title: "   " } }),
    );
    expect(next.blocked[0]!.blocker).toBe("acme/b#7");
    // And it round-trips + stays unchanged on re-resolution (idempotent).
    const again = await resolveBlockers(
      next,
      resolverFrom({ "acme/b#7": { state: "open", title: "" } }),
    );
    expect(again.blocked[0]!.blocker).toBe("acme/b#7");
  });

  test("a long open-blocker title is truncated to 60 chars in the annotation", async () => {
    const state = parse(bodyWith({ blocked: ["- **#10** waiting on acme/b#7 · dep"] }));
    const next = await resolveBlockers(
      state,
      resolverFrom({ "acme/b#7": { state: "open", title: "y".repeat(80) } }),
    );
    expect(next.blocked[0]!.blocker).toBe(`acme/b#7 (${"y".repeat(59)}…)`);
  });

  test("re-resolving is idempotent — a re-annotated open blocker does not accumulate", async () => {
    const state = parse(
      bodyWith({ blocked: ["- **#10** waiting on acme/b#7 (Old title) · cross-repo dep"] }),
    );
    const next = await resolveBlockers(
      state,
      resolverFrom({ "acme/b#7": { state: "open", title: "New title" } }),
    );
    expect(next.blocked[0]!.blocker).toBe("acme/b#7 (New title)");
  });

  test("re-resolving a now-closed previously-stale blocker unblocks it", async () => {
    const state = parse(
      bodyWith({
        blocked: ["- **#10** waiting on #42 (stale blocker: #42) · was gone, now back"],
      }),
    );
    const next = await resolveBlockers(
      state,
      resolverFrom({ "acme/a#42": { state: "closed", title: "Auth" } }),
    );
    expect(next.blocked).toEqual([]);
    expect(next.readyToDispatch).toHaveLength(1);
  });

  test("appended Ready rows are re-ranked after existing rows", async () => {
    const state = parse(
      bodyWith({
        ready: ["| 1 | #5 Existing | claude | 2 | `already ready` |"],
        blocked: ["- **#10** waiting on #42 · dep"],
      }),
    );
    const next = await resolveBlockers(
      state,
      resolverFrom(
        { "acme/a#42": { state: "closed", title: "Auth" } },
        { selfEpic: () => ({ title: "Dashboard", openSubIssues: 1 }) },
      ),
    );
    expect(next.readyToDispatch.map((r) => r.rank)).toEqual([1, 2]);
    expect(next.readyToDispatch[1]!.epic).toBe("#10 Dashboard");
  });

  test("falls back to resolveIssue for the title when selfEpic has no entry", async () => {
    const state = parse(bodyWith({ blocked: ["- **#10** waiting on #42 · dep"] }));
    const next = await resolveBlockers(
      state,
      resolverFrom({
        "acme/a#42": { state: "closed", title: "Auth" },
        "acme/a#10": { state: "open", title: "Standalone issue" },
      }),
    );
    expect(next.readyToDispatch[0]!.epic).toBe("#10 Standalone issue");
    expect(next.readyToDispatch[0]!.subIssues).toBe(1);
  });

  test("the produced state still round-trips through render/parse", async () => {
    const state = parse(
      bodyWith({
        blocked: [
          "- **#10** waiting on acme/b#7 · open cross-repo",
          "- **#11** waiting on acme/b#999 · stale",
        ],
      }),
    );
    const next = await resolveBlockers(
      state,
      resolverFrom({ "acme/b#7": { state: "open", title: "B epic" } }),
    );
    const rendered = renderStateIssue(next);
    expect(renderStateIssue(parse(rendered))).toBe(rendered);
  });

  test("no resolvable blockers → state is returned structurally unchanged", async () => {
    const state = parse(bodyWith({ blocked: ["- **#10** waiting on `external` · note"] }));
    const next = await resolveBlockers(state, resolverFrom({}));
    expect(next).toEqual(state);
  });

  test("a long blocker title is truncated to 60 chars with an ellipsis in the Ready epic", async () => {
    const longTitle = "x".repeat(80);
    const state = parse(bodyWith({ blocked: ["- **#10** waiting on #42 · dep"] }));
    const next = await resolveBlockers(
      state,
      resolverFrom(
        { "acme/a#42": { state: "closed", title: "Auth" } },
        { selfEpic: () => ({ title: longTitle, openSubIssues: 1 }) },
      ),
    );
    // "#10 " + 60 visible chars where the 60th is the ellipsis.
    expect(next.readyToDispatch[0]!.epic).toBe(`#10 ${"x".repeat(59)}…`);
  });
});
