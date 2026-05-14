# Agent Queue State Issue — Schema v1

## Top-level structure

Body has exactly:
1. `<!-- AGENT-QUEUE-STATE v1 -->` marker (REQUIRED, exact)
2. Metadata HTML comment block (REQUIRED)
3. Seven named sections in fixed order (REQUIRED, each as `## <Name>`)
4. `<!-- /AGENT-QUEUE-STATE -->` closing marker (REQUIRED, exact)

Content outside the markers is ignored.

## Metadata

<!-- generated: <ISO 8601> · run: <8-char hex> · interval: <duration> -->
<!-- owners: recommender=..., dispatcher=... -->

## Sections (in order)

Every `#<n>` reference in this body is an **Epic** or a **standalone issue** — the dispatch units. Sub-issues never appear on their own; they are surfaced only as an Epic's phase count and progress.

### 1. ## Ready to dispatch

Table with EXACTLY columns: | Rank | Epic | Adapter | Sub-issues | Reason |
- Rank: int starting at 1, sequential
- Epic: `#<n> <title>` (title truncated to 60 chars with …) — an Epic or a standalone issue
- Adapter: configured adapter name
- Sub-issues: int — count of open sub-issues (the Epic's phase count); `1` for a standalone issue
- Reason: ≤180 chars, single line, only backtick markdown
- Empty state: single row `| — | _no Epics ready_ | — | — | — |`

### 2. ## Needs human input

Bulleted list. Each: `- **#<n> <short label>** — <one-liner> · [link]`
Short labels (stable vocabulary): fork tied, ambiguous criteria, ready for review,
complexity pause, awaiting reply, blocking critical path
(`complexity pause` — an agent paused at a sub-issue whose decision needs more candidate forks than `complexity_ceiling`; resolve by scope reduction or clarification.)

### 3. ## Blocked

Bulleted list. `- **#<n>** waiting on #<blocker> · <context>`
`#<n>` and `#<blocker>` are Epics (or standalone issues). Non-issue blockers: `waiting on \`<description>\``

### 4. ## In-flight  [DISPATCHER-OWNED]

`- **#<n>** · <adapter> · <progress> · last heartbeat <rel> · [tmux: <session>]`
Progress: `sub-issue <m>/<n>` (which phase of the Epic the agent is on) or `running`
Empty: `- _no agents in flight_`

### 5. ## Excluded

`- **#<n>** <reason category> — <detail>`
Categories (closed set): assigned to human, needs-design label,
acceptance criteria missing, no open sub-issues, archived, out of scope

### 6. ## Rate limits  [DISPATCHER-OWNED]

- claude: <AVAILABLE | RATE LIMITED until <ISO> (in <rel>) | UNKNOWN>
- codex: <same>
- github: <n/m req/hr · resets in <rel> | EXHAUSTED until <ISO>>

### 7. ## Slot usage  [DISPATCHER-OWNED]

- <adapter>: <used>/<max>
- (one per configured adapter)
- total: <repo-used>/<repo-max>
- global: <global-used>/<global-max>

## Validation rules

Body PASSES iff:
1. Both markers present
2. All 7 sections in order
3. Ready table has exact column header
4. All #N references match /#\d+/
5. Adapter names are configured
6. Empty sections use documented empty state
7. Metadata `generated` parses as ISO 8601

## Diff semantics

Dispatcher updates In-flight / Rate limits / Slot usage between recommender runs;
does NOT touch `generated`. May insert `<!-- dispatcher-tick: <ts> -->` markers
between sections (ignored by parsers).
Recommender rewrites the entire body on its scheduled run, replacing dispatcher's
eager updates with a fresh full snapshot.

## Parser interface (TypeScript)

```ts
type ParsedState = {
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

function parseStateIssue(body: string): ParsedState | ParseError;
function renderStateIssue(state: ParsedState): string;
function validate(state: ParsedState, config: RepoConfig): ValidationResult;
```

Round-trip property: `renderStateIssue(parseStateIssue(body))` is byte-identical
for any valid body. This is what lets dispatcher edit one section without
disturbing others.
