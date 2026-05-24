import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isParseError,
  parseStateIssue,
  renderStateIssue,
  type InFlightItem,
  type ParsedState,
  type RateLimits,
  type SlotUsage,
} from "@middle/state-issue";

/**
 * The dispatcher's read/write seam onto a repo's state issue. The state issue is
 * the recommender's output and the dashboard's primary read source; the
 * dispatcher only ever edits its three owned sections (In-flight, Rate limits,
 * Slot usage) eagerly between recommender runs. Injecting this gateway keeps the
 * read/write logic testable without `gh`. `repo` is an `owner/name` slug.
 */
export type StateIssueGateway = {
  readBody(repo: string, issueNumber: number): Promise<string>;
  writeBody(repo: string, issueNumber: number, body: string): Promise<void>;
};

/** A partial update to the dispatcher-owned sections; omit a field to keep it. */
export type DispatcherSections = {
  inFlight?: InFlightItem[];
  rateLimits?: RateLimits;
  slotUsage?: SlotUsage;
};

/**
 * Apply a dispatcher-owned-section patch onto a parsed state, leaving every
 * recommender-owned section AND the `generated`/`runId`/`interval` metadata
 * untouched. Because `renderStateIssue(parseStateIssue(body)) === body` for any
 * valid body, re-rendering the result reproduces the untouched sections
 * byte-for-byte — that's the invariant the dispatcher relies on.
 */
export function applyDispatcherSections(
  state: ParsedState,
  patch: DispatcherSections,
): ParsedState {
  return {
    ...state,
    inFlight: patch.inFlight ?? state.inFlight,
    rateLimits: patch.rateLimits ?? state.rateLimits,
    slotUsage: patch.slotUsage ?? state.slotUsage,
  };
}

/**
 * Insert a `<!-- dispatcher-tick: <ts> -->` marker just before the first section
 * header (per the schema's "Diff semantics" — markers go between sections and
 * are ignored by parsers). Any pre-existing dispatcher-tick is dropped first so
 * ticks don't accumulate across eager updates.
 */
export function insertDispatcherTick(body: string, ts: string): string {
  const marker = `<!-- dispatcher-tick: ${ts} -->`;
  const lines = body.split("\n").filter((l) => !/^<!-- dispatcher-tick: .* -->$/.test(l));
  const firstSection = lines.findIndex((l) => l.startsWith("## "));
  if (firstSection === -1) return body; // not a canonical body; leave it alone
  // Place the marker and a blank line above the first section header.
  lines.splice(firstSection, 0, marker, "");
  return lines.join("\n");
}

/** Read and parse a repo's state issue. Throws if the body does not conform. */
export async function readState(
  gw: StateIssueGateway,
  repo: string,
  issueNumber: number,
): Promise<ParsedState> {
  const parsed = parseStateIssue(await gw.readBody(repo, issueNumber));
  if (isParseError(parsed)) {
    throw new Error(`state issue #${issueNumber} does not parse: ${parsed.message}`);
  }
  return parsed;
}

export type UpdateOptions = {
  /** If set, insert a dispatcher-tick marker with this timestamp. */
  tick?: string;
};

/**
 * Read the state issue, overwrite only the dispatcher-owned sections, and write
 * it back. Returns the before/after bodies (the caller can diff or log them).
 * Recommender-owned sections survive byte-identically.
 */
export async function updateDispatcherSections(
  gw: StateIssueGateway,
  repo: string,
  issueNumber: number,
  patch: DispatcherSections,
  opts: UpdateOptions = {},
): Promise<{ before: string; after: string }> {
  const before = await gw.readBody(repo, issueNumber);
  const parsed = parseStateIssue(before);
  if (isParseError(parsed)) {
    throw new Error(`state issue #${issueNumber} does not parse: ${parsed.message}`);
  }
  let after = renderStateIssue(applyDispatcherSections(parsed, patch));
  if (opts.tick) after = insertDispatcherTick(after, opts.tick);
  await gw.writeBody(repo, issueNumber, after);
  return { before, after };
}

async function run(
  argv: string[],
  stdin?: string,
): Promise<{ stdout: string; exitCode: number; stderr: string }> {
  const proc = Bun.spawn(argv, {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exitCode: await proc.exited };
}

/** The production gateway — reads/writes the state issue through the `gh` CLI. */
export const ghStateIssueGateway: StateIssueGateway = {
  async readBody(repo: string, issueNumber: number): Promise<string> {
    const result = await run([
      "gh",
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "body",
      "--jq",
      ".body",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`gh issue view #${issueNumber} failed: ${result.stderr.trim()}`);
    }
    // gh --jq appends a trailing newline; the body itself ends at the close marker.
    return result.stdout.replace(/\n$/, "");
  },

  async writeBody(repo: string, issueNumber: number, body: string): Promise<void> {
    const bodyFile = join(tmpdir(), `middle-state-write-${issueNumber}-${Date.now()}.md`);
    await writeFile(bodyFile, body);
    try {
      const result = await run([
        "gh",
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        repo,
        "--body-file",
        bodyFile,
      ]);
      if (result.exitCode !== 0) {
        throw new Error(`gh issue edit #${issueNumber} failed: ${result.stderr.trim()}`);
      }
    } finally {
      await rm(bodyFile, { force: true });
    }
  },
};
