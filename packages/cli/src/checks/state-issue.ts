import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isParseError,
  type ParsedState,
  parseStateIssue,
  renderStateIssue,
  validate,
} from "@middle/state-issue";

/**
 * @packageDocumentation
 * @module @middle/cli/checks/state-issue
 *
 * The `mm doctor` state-issue self-check: re-validate the parser/renderer/validate
 * machinery against `schemas/state-issue.v1.md` (the schema source of truth) using
 * the package's canonical conforming fixture. A parse failure, a broken
 * byte-identical round-trip, or a failed `validate()` means the parser has drifted
 * from the schema doc and the dispatcher's read/write of state issues is unsafe.
 *
 * Public surface:
 * - `checkStateIssue` — resolve the schema doc + fixture from middle's source tree
 *   and run the round-trip, returning a doctor check status
 * - `checkStateIssueRoundTrip` — the pure parse → render → validate check (testable)
 * - `SCHEMA_DOC_PATH`, `STATE_ISSUE_FIXTURE_PATH` — the resolved source-tree paths
 *
 * Where things live:
 * - this file — the whole check (resolves paths like the module-index check does)
 *
 * Gotchas:
 * - Paths resolve from this module's location so the check inspects middle's own
 *   source tree, not the cwd's repo (matches the skills-drift / module-index checks).
 * - The fixture is a fixed conformance artifact; the check uses the same adapter
 *   set the fixture's own round-trip test does (`claude`, `codex`) — it is a
 *   self-test of the machinery, independent of the operator's configured adapters.
 *
 * claude-md: false
 */

/** middle's repo root, resolved from this file (`packages/cli/src/checks` → up 4). */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

/** The schema source of truth the parser/renderer/validate conform to. */
export const SCHEMA_DOC_PATH = join(REPO_ROOT, "schemas", "state-issue.v1.md");

/** The canonical conforming state-issue body the round-trip is checked against. */
export const STATE_ISSUE_FIXTURE_PATH = join(
  REPO_ROOT,
  "packages",
  "state-issue",
  "test",
  "fixtures",
  "state-issue.example.md",
);

/**
 * Adapter set the fixture is authored against — kept in lockstep with the
 * fixture's own round-trip test (`packages/state-issue/test/fixture.test.ts`).
 * The check is a self-test of the parse/render/validate machinery, so the
 * adapter set comes from the fixture, not the operator's config.
 */
const FIXTURE_ADAPTERS = ["claude", "codex"] as const;

/** Outcome of the pure round-trip check: did the machinery hold, and why/why not. */
export type StateIssueCheckResult = { ok: boolean; detail: string };

/**
 * The pure check: `parseStateIssue` the body, assert the parse succeeded, assert
 * `renderStateIssue` reproduces the body **byte-identically** (the hard round-trip
 * invariant the dispatcher relies on to edit one section without disturbing
 * others), and assert `validate` passes. Returns the first failure it hits.
 */
export function checkStateIssueRoundTrip(body: string, adapters: string[]): StateIssueCheckResult {
  const parsed = parseStateIssue(body);
  if (isParseError(parsed)) return { ok: false, detail: `parse failed — ${parsed.message}` };
  const rendered = renderStateIssue(parsed);
  if (rendered !== body) {
    return { ok: false, detail: "round-trip broken — render is not byte-identical to the fixture" };
  }
  const result = validate(parsed as ParsedState, { adapters });
  if (!result.ok) return { ok: false, detail: `validate failed — ${result.errors.join("; ")}` };
  return { ok: true, detail: "parser ↔ renderer round-trip + validate OK against v1 schema" };
}

/** A doctor check status: pass when the machinery holds, fail when it drifted. */
export type StateIssueCheckStatus = { status: "pass" | "warn" | "fail"; detail: string };

/**
 * Resolve the schema doc + canonical fixture from middle's source tree and run
 * {@link checkStateIssueRoundTrip}. Degrades to `warn` (not `fail`) when either
 * artifact is absent — that's an unusual install layout, not a parser defect.
 */
export function checkStateIssue(): StateIssueCheckStatus {
  if (!existsSync(SCHEMA_DOC_PATH)) {
    return { status: "warn", detail: "schemas/state-issue.v1.md not found — skipped" };
  }
  if (!existsSync(STATE_ISSUE_FIXTURE_PATH)) {
    return { status: "warn", detail: "canonical state-issue fixture not found — skipped" };
  }
  try {
    const body = readFileSync(STATE_ISSUE_FIXTURE_PATH, "utf8");
    const result = checkStateIssueRoundTrip(body, [...FIXTURE_ADAPTERS]);
    return result.ok
      ? { status: "pass", detail: result.detail }
      : { status: "fail", detail: result.detail };
  } catch (error) {
    return {
      status: "fail",
      detail: `state-issue fixture unreadable — ${(error as Error).message}`,
    };
  }
}
