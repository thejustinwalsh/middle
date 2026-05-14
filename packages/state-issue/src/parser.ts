import {
  CLOSE_MARKER,
  DISPATCHER_TICK_RE,
  IN_FLIGHT_EMPTY,
  OPEN_MARKER,
  OWNERS_LINE,
  READY_EMPTY_ROW,
  READY_TABLE_HEADER,
  READY_TABLE_SEPARATOR,
  SECTION_NAMES,
} from "./constants.ts";
import type {
  AdapterSlotUsage,
  BlockedItem,
  ExcludedItem,
  InFlightItem,
  NeedsHumanItem,
  ParseError,
  ParsedState,
  RateLimits,
  ReadyRow,
  SlotCount,
  SlotUsage,
} from "./schema.v1.ts";

/** Type guard distinguishing a ParseError from a ParsedState. */
export function isParseError(value: ParsedState | ParseError): value is ParseError {
  return (value as Partial<ParseError>).kind === "ParseError";
}

class ParseFailure extends Error {}

function fail(message: string): never {
  throw new ParseFailure(message);
}

const META_RE = /^<!-- generated: (.+?) · run: (\S+) · interval: (\d+)m -->$/;

/**
 * Parse a schema-conforming state-issue body into a ParsedState.
 * Content outside the markers, and dispatcher-tick markers, are ignored.
 * Returns a ParseError when the body does not conform.
 */
export function parseStateIssue(body: string): ParsedState | ParseError {
  try {
    return doParse(body);
  } catch (err) {
    if (err instanceof ParseFailure) return { kind: "ParseError", message: err.message };
    throw err;
  }
}

function doParse(body: string): ParsedState {
  const lines = body.split("\n");
  const openIdx = lines.indexOf(OPEN_MARKER);
  if (openIdx === -1) fail("missing open marker");
  const closeIdx = lines.indexOf(CLOSE_MARKER, openIdx + 1);
  if (closeIdx === -1) fail("missing close marker");

  // Drop dispatcher-tick markers — "ignored by parsers" per the schema doc.
  const inner = lines
    .slice(openIdx + 1, closeIdx)
    .filter((line) => !DISPATCHER_TICK_RE.test(line));

  const metaMatch = META_RE.exec(inner[0] ?? "");
  if (!metaMatch) fail("malformed metadata line");
  if ((inner[1] ?? "") !== OWNERS_LINE) fail("missing or malformed owners line");
  const [, generated, runId, intervalRaw] = metaMatch;

  const sections = groupSections(inner.slice(2));

  return {
    version: 1,
    generated: generated!,
    runId: runId!,
    intervalMinutes: Number(intervalRaw),
    readyToDispatch: parseReady(sections[0]!),
    needsHumanInput: parseNeeds(sections[1]!),
    blocked: parseBlocked(sections[2]!),
    inFlight: parseInFlight(sections[3]!),
    excluded: parseExcluded(sections[4]!),
    rateLimits: parseRateLimits(sections[5]!),
    slotUsage: parseSlotUsage(sections[6]!),
  };
}

/** Group section lines by "## <Name>" headers, validating names and order. */
function groupSections(sectionLines: string[]): string[][] {
  const sections: { name: string; content: string[] }[] = [];
  for (const line of sectionLines) {
    const header = /^## (.+)$/.exec(line);
    if (header) {
      sections.push({ name: header[1]!, content: [] });
    } else if (sections.length > 0) {
      sections[sections.length - 1]!.content.push(line);
    } else if (line.trim() !== "") {
      fail(`unexpected content before first section: "${line}"`);
    }
  }

  if (sections.length !== SECTION_NAMES.length) {
    fail(`expected ${SECTION_NAMES.length} sections, found ${sections.length}`);
  }
  return sections.map((section, i) => {
    if (section.name !== SECTION_NAMES[i]) {
      fail(`section ${i + 1} should be "${SECTION_NAMES[i]}", found "${section.name}"`);
    }
    return trimBlankEdges(section.content);
  });
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  return lines.slice(start, end);
}

function splitTableRow(row: string): string[] {
  if (!row.startsWith("| ") || !row.endsWith(" |")) {
    fail(`malformed table row: "${row}"`);
  }
  return row.slice(2, -2).split(" | ");
}

function int(raw: string, what: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value)) fail(`${what} is not an integer: "${raw}"`);
  return value;
}

function parseReady(content: string[]): ReadyRow[] {
  if (content[0] !== READY_TABLE_HEADER) fail("Ready table has the wrong column header");
  if (content[1] !== READY_TABLE_SEPARATOR) fail("Ready table has a malformed separator row");
  const rows = content.slice(2);
  if (rows.length === 1 && rows[0] === READY_EMPTY_ROW) return [];
  return rows.map((row) => {
    const cells = splitTableRow(row);
    if (cells.length !== 5) fail(`Ready row has ${cells.length} cells, expected 5`);
    const [rank, epic, adapter, subIssues, reason] = cells;
    return {
      rank: int(rank!, "Ready row rank"),
      epic: epic!,
      adapter: adapter!,
      subIssues: int(subIssues!, "Ready row sub-issues"),
      reason: reason!,
    };
  });
}

const NEEDS_RE = /^- \*\*#(\d+) (.+?)\*\* — (.+) · (.+)$/;

function parseNeeds(content: string[]): NeedsHumanItem[] {
  return content.map((line) => {
    const m = NEEDS_RE.exec(line);
    if (!m) fail(`malformed "Needs human input" item: "${line}"`);
    return { issue: Number(m[1]), label: m[2]!, oneLiner: m[3]!, link: m[4]! };
  });
}

const BLOCKED_RE = /^- \*\*#(\d+)\*\* waiting on (.+) · (.+)$/;

function parseBlocked(content: string[]): BlockedItem[] {
  return content.map((line) => {
    const m = BLOCKED_RE.exec(line);
    if (!m) fail(`malformed "Blocked" item: "${line}"`);
    return { issue: Number(m[1]), blocker: m[2]!, context: m[3]! };
  });
}

const IN_FLIGHT_RE =
  /^- \*\*#(\d+)\*\* · (.+?) · (.+?) · last heartbeat (.+?) · \[tmux: (.+?)\]$/;

function parseInFlight(content: string[]): InFlightItem[] {
  if (content.length === 1 && content[0] === IN_FLIGHT_EMPTY) return [];
  return content.map((line) => {
    const m = IN_FLIGHT_RE.exec(line);
    if (!m) fail(`malformed "In-flight" item: "${line}"`);
    return {
      issue: Number(m[1]),
      adapter: m[2]!,
      progress: m[3]!,
      lastHeartbeat: m[4]!,
      tmuxSession: m[5]!,
    };
  });
}

const EXCLUDED_RE = /^- \*\*#(\d+)\*\* (.+) — (.+)$/;

function parseExcluded(content: string[]): ExcludedItem[] {
  return content.map((line) => {
    const m = EXCLUDED_RE.exec(line);
    if (!m) fail(`malformed "Excluded" item: "${line}"`);
    return { issue: Number(m[1]), category: m[2]!, detail: m[3]! };
  });
}

function rateLimitLine(line: string | undefined, key: keyof RateLimits): string {
  const prefix = `- ${key}: `;
  if (!line || !line.startsWith(prefix)) fail(`malformed "Rate limits" ${key} line: "${line}"`);
  return line.slice(prefix.length);
}

function parseRateLimits(content: string[]): RateLimits {
  if (content.length !== 3) fail(`"Rate limits" must have 3 lines, found ${content.length}`);
  return {
    claude: rateLimitLine(content[0], "claude"),
    codex: rateLimitLine(content[1], "codex"),
    github: rateLimitLine(content[2], "github"),
  };
}

const SLOT_RE = /^- (.+): (\d+)\/(\d+)$/;

function parseSlotCount(line: string | undefined, label: string): SlotCount {
  const m = line ? SLOT_RE.exec(line) : null;
  if (!m || m[1] !== label) fail(`malformed "Slot usage" ${label} line: "${line}"`);
  return { used: Number(m[2]), max: Number(m[3]) };
}

function parseSlotUsage(content: string[]): SlotUsage {
  if (content.length < 2) fail('"Slot usage" must have at least total and global lines');
  const adapterLines = content.slice(0, -2);
  const adapters: AdapterSlotUsage[] = adapterLines.map((line) => {
    const m = SLOT_RE.exec(line);
    if (!m) fail(`malformed "Slot usage" adapter line: "${line}"`);
    return { adapter: m[1]!, used: Number(m[2]), max: Number(m[3]) };
  });
  return {
    adapters,
    total: parseSlotCount(content[content.length - 2], "total"),
    global: parseSlotCount(content[content.length - 1], "global"),
  };
}
