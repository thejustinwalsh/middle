/**
 * @packageDocumentation
 * @module @middle/state-issue
 *
 * Parse, render, and validate the dispatcher's GitHub state issue — the keystone
 * the dispatcher edits section-by-section.
 *
 * Public surface:
 * - `parseStateIssue` / `isParseError` — Markdown → `ParsedState`
 * - `renderStateIssue` — `ParsedState` → Markdown
 * - `validate` — schema conformance for a parsed state
 * - `STATE_ISSUE_SCHEMA_PATH` — abs path to the canonical schema in the middle install
 * - the row/section types (`InFlightItem`, `ReadyRow`, `RateLimits`, …)
 *
 * Where things live:
 * - `schema.v1.ts` — the v1 row/section types
 * - `parser.ts` — Markdown → state
 * - `renderer.ts` — state → Markdown
 * - `validate.ts` — conformance checks
 * - `constants.ts` — fixed metadata lines that anchor the round-trip
 * - `schema-path.ts` — resolves the on-disk schema from the middle install
 *
 * Gotchas:
 * - Byte-identical round-trip is a hard invariant (see `schemas/state-issue.v1.md`
 *   and the root CLAUDE.md "state-issue contract"); local mechanics in this
 *   package's CLAUDE.md.
 *
 * claude-md: true
 */
export type {
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
  ValidationResult,
} from "./schema.v1.ts";
export { isParseError, parseStateIssue } from "./parser.ts";
export { renderStateIssue } from "./renderer.ts";
export { STATE_ISSUE_SCHEMA_PATH } from "./schema-path.ts";
export { validate } from "./validate.ts";
