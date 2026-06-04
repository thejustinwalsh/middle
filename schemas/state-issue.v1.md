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

Bulleted list. `- **#<n>** waiting on <blocker> · <context>`
`#<n>` is an Epic (or standalone issue) in this repo. `<blocker>` is one of:
- **Same-repo issue:** `#<blocker>` — an Epic/issue in this repo.
- **Cross-repo issue:** `<owner>/<repo>#<blocker>` — an Epic/issue in another repo
  (e.g. `acme/widgets#42`). This is the runtime-resolvable cross-repo blocker (#225):
  repo A's Epic can be blocked on repo B's Epic.
- **Non-issue:** `` `<description>` `` (backticked) — an external dependency with no
  issue to resolve against.

**Recommender resolution semantics (#225).** On each recommender run, after the
agent rewrites the body, the dispatcher resolves every issue-reference blocker
(same-repo and cross-repo; backticked descriptions are never resolved) against live
state and reclassifies the blocked item:
- **Blocker closed** → the item moves to `## Ready to dispatch` (a best-effort row
  the next full recommender run re-ranks).
- **Blocker still open** → stays in `## Blocked`; the blocker is annotated with the
  resolved title: `<ref> (<title>)`.
- **Blocker unresolvable** (404 / deleted, or a file-mode slug with no Epic file) →
  stays in `## Blocked` with a `<ref> (stale blocker: <ref>)` suffix.

Re-resolution is idempotent: an existing `(<title>)` / `(stale blocker: …)`
annotation is stripped before the reference is re-read, so the line never
accumulates annotations. Cross-repo references in **file mode** are out of scope for
v1 (same-repo file-mode references resolve; cross-repo is a v2 step).

### 4. ## In-flight  [DISPATCHER-OWNED]

`- **#<ref>** · <adapter> · <progress> · last heartbeat <rel> · [tmux: <session>]`
`<ref>` is the dispatched Epic: a numeric Epic/issue number in github mode, or a
file-mode Epic **slug** for a repo whose Epic store is file-backed — a file Epic
has no GitHub issue number, so its in-flight row carries the slug. The slug is a
file-stem token, not strictly kebab-case: the parser captures any run of
non-space, non-`*` characters (so dots and mixed tokens are valid, e.g.
`rollout-epic-store` or `v1.2-rollout`) to keep the round-trip byte-exact for
whatever stem the file store produced. Progress: `sub-issue <m>/<n>` (which phase
of the Epic the agent is on) or `running`
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
4. Numeric `#N` references match /#\d+/ — scoped to **Ready** row epics and
   **Blocked** issue blockers. A Blocked blocker may carry an optional
   `<owner>/<repo>` cross-repo prefix and an optional trailing `(<title>)` /
   `(stale blocker: <ref>)` annotation; a backticked or free-text non-issue blocker
   is exempt. In-flight `<ref>` is exempt: it may be a file-mode Epic slug (see
   In-flight above), so it is not constrained to /#\d+/.
5. Adapter names are configured
6. Empty sections use documented empty state
7. Metadata `generated` parses as ISO 8601

**Empty-state leniency (parser).** The renderer emits the canonical empty form
(no bullet for Needs human input / Blocked / Excluded; `- _no agents in flight_`
for In-flight). The parser is deliberately lenient on *input*, since agents
author these bodies: a list section is read as empty when it has no bullets **or**
when every bullet is an italic placeholder sentinel (`- _…_` / `- *…*`, e.g.
`- _none_`). This relaxes only the empty-state shape — per-item parsing stays
strict (a real item is always `- **#<n> …**`), and round-trip byte-identity is
unaffected (the canonical forms still parse and re-render verbatim).

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
