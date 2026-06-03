import { describe, expect, test } from "bun:test";
import {
  isParseError,
  parseStateIssue,
  renderStateIssue,
  type ParsedState,
} from "@middle/state-issue";
import {
  applyDispatcherSections,
  insertDispatcherTick,
  readState,
  updateDispatcherSections,
  type StateGateway,
} from "../src/state-issue.ts";

/** A full, recommender-populated state — the kind the dispatcher edits in place. */
const original: ParsedState = {
  version: 1,
  generated: "2026-05-14T09:15:00Z",
  runId: "7f3a9c21",
  intervalMinutes: 15,
  readyToDispatch: [
    {
      rank: 1,
      epic: "#42 Recommender workflow",
      adapter: "claude",
      subIssues: 6,
      reason: "`unblocks dogfooding`",
    },
    { rank: 2, epic: "#60 CodexAdapter", adapter: "codex", subIssues: 4, reason: "parity testing" },
  ],
  needsHumanInput: [
    {
      issue: 7,
      label: "ready for review",
      oneLiner: "PR open, all verified",
      link: "[link](https://x/7)",
    },
  ],
  blocked: [{ issue: 48, blocker: "#42", context: "needs the recommender first" }],
  inFlight: [
    {
      issue: "64",
      adapter: "claude",
      progress: "sub-issue 2/5",
      lastHeartbeat: "42s ago",
      tmuxSession: "middle-epic-64",
    },
  ],
  excluded: [{ issue: 3, category: "assigned to human", detail: "hand-tuning" }],
  rateLimits: {
    claude: "AVAILABLE",
    codex: "RATE LIMITED until 2026-05-14T10:30:00Z (in 1h 15m)",
    github: "4612/5000 req/hr · resets in 27m",
  },
  slotUsage: {
    adapters: [
      { adapter: "claude", used: 1, max: 2 },
      { adapter: "codex", used: 0, max: 1 },
    ],
    total: { used: 1, max: 3 },
    global: { used: 1, max: 4 },
  },
};

/** Split a body into a name→block map (header line through trailing blanks). */
function sections(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  let cur: string | null = null;
  let buf: string[] = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("## ")) {
      if (cur) out[cur] = buf.join("\n");
      cur = line.slice(3);
      buf = [line];
    } else if (cur) {
      if (line === "<!-- /AGENT-QUEUE-STATE -->") {
        out[cur] = buf.join("\n");
        cur = null;
      } else buf.push(line);
    }
  }
  if (cur) out[cur] = buf.join("\n");
  return out;
}

const RECOMMENDER_SECTIONS = ["Ready to dispatch", "Needs human input", "Blocked", "Excluded"];

function makeGateway(body: string): { gw: StateGateway; written: () => string | null } {
  let store = body;
  let lastWrite: string | null = null;
  return {
    gw: {
      readBody: async () => store,
      writeBody: async (_repo, _n, b) => {
        store = b;
        lastWrite = b;
      },
    },
    written: () => lastWrite,
  };
}

describe("applyDispatcherSections", () => {
  test("replaces only the three owned sections, keeps the rest", () => {
    const next = applyDispatcherSections(original, {
      inFlight: [],
      rateLimits: { claude: "UNKNOWN", codex: "UNKNOWN", github: "UNKNOWN" },
    });
    expect(next.inFlight).toEqual([]);
    expect(next.rateLimits.claude).toBe("UNKNOWN");
    // untouched
    expect(next.slotUsage).toEqual(original.slotUsage);
    expect(next.readyToDispatch).toEqual(original.readyToDispatch);
    expect(next.generated).toBe(original.generated);
    expect(next.runId).toBe(original.runId);
  });
});

describe("updateDispatcherSections", () => {
  const body0 = renderStateIssue(original);

  test("recommender-owned sections come back byte-identical", async () => {
    const { gw, written } = makeGateway(body0);
    await updateDispatcherSections(gw, "acme/widget", 142, {
      inFlight: [],
      rateLimits: {
        claude: "RATE LIMITED until 2026-05-14T11:00:00Z (in 30m)",
        codex: "AVAILABLE",
        github: "5000/5000 req/hr · resets in 60m",
      },
      slotUsage: {
        adapters: [{ adapter: "claude", used: 0, max: 2 }],
        total: { used: 0, max: 3 },
        global: { used: 0, max: 4 },
      },
    });

    const before = sections(body0);
    const after = sections(written()!);
    for (const name of RECOMMENDER_SECTIONS) {
      expect(after[name]).toBe(before[name]!);
    }
    // metadata header (generated/run/interval) is untouched too
    expect(written()!.split("\n").slice(0, 3)).toEqual(body0.split("\n").slice(0, 3));
  });

  test("the owned sections actually changed", async () => {
    const { gw, written } = makeGateway(body0);
    await updateDispatcherSections(gw, "acme/widget", 142, { inFlight: [] });
    const parsed = parseStateIssue(written()!);
    if (isParseError(parsed)) throw new Error("written body must parse");
    expect(parsed.inFlight).toEqual([]);
    expect(sections(written()!)["In-flight"]).not.toBe(sections(body0)["In-flight"]!);
  });

  test("a partial patch leaves the unspecified owned sections intact", async () => {
    const { gw, written } = makeGateway(body0);
    await updateDispatcherSections(gw, "acme/widget", 142, {
      rateLimits: { claude: "UNKNOWN", codex: "UNKNOWN", github: "UNKNOWN" },
    });
    const parsed = parseStateIssue(written()!);
    if (isParseError(parsed)) throw new Error("written body must parse");
    expect(parsed.inFlight).toEqual(original.inFlight); // untouched
    expect(parsed.slotUsage).toEqual(original.slotUsage); // untouched
    expect(parsed.rateLimits.claude).toBe("UNKNOWN");
  });

  test("a dispatcher-tick marker is ignored by the parser and preserves sections", async () => {
    const { gw, written } = makeGateway(body0);
    await updateDispatcherSections(
      gw,
      "acme/widget",
      142,
      { inFlight: [] },
      { tick: "2026-05-14T09:20:00Z" },
    );
    const body = written()!;
    expect(body).toContain("<!-- dispatcher-tick: 2026-05-14T09:20:00Z -->");
    const parsed = parseStateIssue(body);
    expect(isParseError(parsed)).toBe(false);
    // recommender sections still byte-identical despite the inserted marker
    const after = sections(body);
    const before = sections(body0);
    for (const name of RECOMMENDER_SECTIONS) expect(after[name]).toBe(before[name]!);
  });

  test("ticks do not accumulate across repeated updates", async () => {
    const { gw, written } = makeGateway(body0);
    await updateDispatcherSections(gw, "r", 1, { inFlight: [] }, { tick: "t1" });
    await updateDispatcherSections(gw, "r", 1, { inFlight: [] }, { tick: "t2" });
    const body = written()!;
    expect(body).toContain("dispatcher-tick: t2");
    expect(body).not.toContain("dispatcher-tick: t1");
    expect((body.match(/dispatcher-tick/g) ?? []).length).toBe(1);
  });
});

describe("readState", () => {
  test("parses a valid body", async () => {
    const { gw } = makeGateway(renderStateIssue(original));
    const state = await readState(gw, "acme/widget", 142);
    expect(state.runId).toBe("7f3a9c21");
    expect(state.readyToDispatch).toHaveLength(2);
  });

  test("throws on a malformed body", async () => {
    const { gw } = makeGateway("not a state issue");
    await expect(readState(gw, "acme/widget", 142)).rejects.toThrow(/does not parse/);
  });
});

describe("insertDispatcherTick", () => {
  test("leaves a non-canonical body untouched", () => {
    expect(insertDispatcherTick("garbage\nbody", "t")).toBe("garbage\nbody");
  });
});
