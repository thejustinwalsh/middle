// Canonical format constants for the state-issue v1 body — the literal strings
// the renderer emits and the parser requires. See schemas/state-issue.v1.md.

export const OPEN_MARKER = "<!-- AGENT-QUEUE-STATE v1 -->";
export const CLOSE_MARKER = "<!-- /AGENT-QUEUE-STATE -->";

// The owners line is a fixed constant. ParsedState (per the schema doc's parser
// interface) carries no owners field, so round-trip byte-identity can only hold
// if this non-captured metadata line is invariant.
export const OWNERS_LINE =
  "<!-- owners: recommender=full-body, dispatcher=in-flight,rate-limits,slot-usage -->";

/** The seven sections, in their fixed required order. */
export const SECTION_NAMES = [
  "Ready to dispatch",
  "Needs human input",
  "Blocked",
  "In-flight",
  "Excluded",
  "Rate limits",
  "Slot usage",
] as const;

export const READY_TABLE_HEADER = "| Rank | Epic | Adapter | Sub-issues | Reason |";
export const READY_TABLE_SEPARATOR = "| --- | --- | --- | --- | --- |";
export const READY_EMPTY_ROW = "| — | _no Epics ready_ | — | — | — |";
export const IN_FLIGHT_EMPTY = "- _no agents in flight_";

// Dispatcher may insert these between sections; parsers ignore them.
export const DISPATCHER_TICK_RE = /^<!-- dispatcher-tick: .* -->$/;
