import type { ParsedState } from "../src/schema.v1.ts";

// Shared sample states for parser/renderer/validate tests.

export const emptyState: ParsedState = {
  version: 1,
  generated: "2026-05-14T12:00:00Z",
  runId: "a1b2c3d4",
  intervalMinutes: 15,
  readyToDispatch: [],
  needsHumanInput: [],
  blocked: [],
  inFlight: [],
  excluded: [],
  rateLimits: {
    claude: "AVAILABLE",
    codex: "AVAILABLE",
    github: "5000/5000 req/hr · resets in 60m",
  },
  slotUsage: {
    adapters: [],
    total: { used: 0, max: 0 },
    global: { used: 0, max: 0 },
  },
};

export const fullState: ParsedState = {
  version: 1,
  generated: "2026-05-14T12:00:00Z",
  runId: "deadbeef",
  intervalMinutes: 30,
  readyToDispatch: [
    {
      rank: 1,
      epic: "#42 Recommender workflow",
      adapter: "claude",
      subIssues: 6,
      reason: "`unblocks dogfooding`",
    },
    {
      rank: 2,
      epic: "#48 Auto-dispatch and limits",
      adapter: "codex",
      subIssues: 5,
      reason: "next in build sequence",
    },
  ],
  needsHumanInput: [
    {
      issue: 7,
      label: "ready for review",
      oneLiner: "PR open, all phases verified",
      link: "[link](https://example.com/issues/7)",
    },
  ],
  blocked: [
    { issue: 9, blocker: "#42", context: "needs the recommender first" },
    { issue: 10, blocker: "`upstream release`", context: "waiting on vendor" },
  ],
  inFlight: [
    {
      issue: 54,
      adapter: "claude",
      progress: "sub-issue 2/5",
      lastHeartbeat: "30s ago",
      tmuxSession: "middle-54",
    },
  ],
  excluded: [{ issue: 3, category: "assigned to human", detail: "being handled manually" }],
  rateLimits: {
    claude: "AVAILABLE",
    codex: "RATE LIMITED until 2026-05-14T13:00:00Z (in 1h)",
    github: "4823/5000 req/hr · resets in 42m",
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
