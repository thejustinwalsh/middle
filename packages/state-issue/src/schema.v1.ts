// Types matching schemas/state-issue.v1.md — the state-issue v1 schema doc.
// schemas/state-issue.v1.md is the source of truth; these types conform to it.
// Sub-type field shapes are derived from the doc's per-section format
// descriptions (the doc's "Parser interface" block names the sub-types but
// does not enumerate their fields).

/** A row of the "Ready to dispatch" table. */
export type ReadyRow = {
  rank: number;
  /** The raw Epic cell, "#<n> <title>". */
  epic: string;
  adapter: string;
  /** Count of open sub-issues; 1 for a standalone issue. */
  subIssues: number;
  /** Single line, ≤180 chars, backtick markdown only. */
  reason: string;
};

/** An item under "Needs human input". */
export type NeedsHumanItem = {
  issue: number;
  /** Stable vocabulary: fork tied, ambiguous criteria, ready for review, etc. */
  label: string;
  oneLiner: string;
  /** The trailing link cell, e.g. "[link](url)". */
  link: string;
};

/** An item under "Blocked". */
export type BlockedItem = {
  issue: number;
  /** "#<n>" for an issue blocker, or "`<description>`" for a non-issue blocker. */
  blocker: string;
  context: string;
};

/** An item under "In-flight" (dispatcher-owned section). */
export type InFlightItem = {
  issue: number;
  adapter: string;
  /** "sub-issue <m>/<n>" or "running". */
  progress: string;
  lastHeartbeat: string;
  tmuxSession: string;
};

/** An item under "Excluded". */
export type ExcludedItem = {
  issue: number;
  /** Closed set, see schema doc. */
  category: string;
  detail: string;
};

/** The "Rate limits" section (dispatcher-owned). */
export type RateLimits = {
  claude: string;
  codex: string;
  github: string;
};

export type SlotCount = {
  used: number;
  max: number;
};

export type AdapterSlotUsage = SlotCount & {
  adapter: string;
};

/** The "Slot usage" section (dispatcher-owned). */
export type SlotUsage = {
  adapters: AdapterSlotUsage[];
  total: SlotCount;
  global: SlotCount;
};

/** A parsed, schema-conforming state-issue body. */
export type ParsedState = {
  version: 1;
  generated: string;
  runId: string;
  intervalMinutes: number;
  readyToDispatch: ReadyRow[];
  needsHumanInput: NeedsHumanItem[];
  blocked: BlockedItem[];
  inFlight: InFlightItem[];
  excluded: ExcludedItem[];
  rateLimits: RateLimits;
  slotUsage: SlotUsage;
};

/** Returned by parseStateIssue when the body does not conform to the schema. */
export type ParseError = {
  readonly kind: "ParseError";
  readonly message: string;
};

/** Returned by validate. */
export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] };
