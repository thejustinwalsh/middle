import { renderStateIssue } from "@middle/state-issue";

/**
 * The initial, empty, schema-conforming state-issue body `mm init` creates.
 *
 * Every section is at its documented empty state; rate limits are `UNKNOWN`
 * (nothing has been measured yet) and slot usage is zeroed. The recommender
 * overwrites the whole body on its first run; the dispatcher only ever edits its
 * three owned sections. This passes `parseStateIssue` and `validate`.
 */
export function buildInitialStateIssueBody(now: Date, intervalMinutes = 15): string {
  return renderStateIssue({
    version: 1,
    generated: now.toISOString(),
    runId: "00000000",
    intervalMinutes,
    readyToDispatch: [],
    needsHumanInput: [],
    blocked: [],
    inFlight: [],
    excluded: [],
    rateLimits: { claude: "UNKNOWN", codex: "UNKNOWN", github: "UNKNOWN" },
    slotUsage: { adapters: [], total: { used: 0, max: 0 }, global: { used: 0, max: 0 } },
  });
}
