import type { RepoConfig } from "@middle/core";
import type { ParsedState, ValidationResult } from "./schema.v1.ts";

// Enforces the schema doc's "Validation rules". Rules 1-3 and 6 (markers,
// section presence/order, Ready table header, documented empty states) are
// structural and already guaranteed by a successful parseStateIssue; this
// function re-checks the rules that depend on field values and config:
// rule 4 (#N reference shape), rule 5 (configured adapters), rule 7 (ISO 8601).

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const EPIC_REF_RE = /^#\S+\s+\S/;
// A Blocked blocker reference: an optional `<owner>/<repo>` prefix (a cross-repo
// blocker, #225), then `#<n>`, optionally carrying a resolved-title or
// `(stale blocker: <ref>)` annotation the recommender's resolution pass appends.
const BLOCKER_REF_RE = /^(?:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)?#\d+(?: \(.+\))?$/;
// Whether a blocker is *attempting* to be an issue/cross-repo reference (vs a
// backticked or free-text non-issue blocker, which carry no `#<n>` and are exempt).
const REF_LIKE_BLOCKER_RE = /^(?:#|[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#)/;

export function validate(state: ParsedState, config: RepoConfig): ValidationResult {
  const errors: string[] = [];
  const configured = new Set(config.adapters);

  // Rule 7: metadata `generated` parses as ISO 8601.
  if (!ISO_8601_RE.test(state.generated) || Number.isNaN(Date.parse(state.generated))) {
    errors.push(`generated is not ISO 8601: "${state.generated}"`);
  }

  // Rule 4: all #N references match /#\d+/.
  for (const row of state.readyToDispatch) {
    if (!EPIC_REF_RE.test(row.epic)) {
      errors.push(`Ready row epic is not a "#<ref> <title>" reference: "${row.epic}"`);
    }
  }
  for (const item of state.blocked) {
    // A blocker is a same-repo `#<n>`, a cross-repo `<owner>/<repo>#<n>` (each
    // optionally annotated with a resolved title or `(stale blocker: …)`), or a
    // backticked / free-text non-issue blocker (exempt). Only validate the shape
    // of one that's *trying* to be an issue reference.
    if (REF_LIKE_BLOCKER_RE.test(item.blocker) && !BLOCKER_REF_RE.test(item.blocker)) {
      errors.push(`Blocked blocker is not a valid issue/cross-repo reference: "${item.blocker}"`);
    }
  }

  // Rule 5: adapter names are configured.
  for (const row of state.readyToDispatch) {
    if (!configured.has(row.adapter)) {
      errors.push(`Ready row uses unconfigured adapter: "${row.adapter}"`);
    }
  }
  for (const item of state.inFlight) {
    if (!configured.has(item.adapter)) {
      errors.push(`In-flight item uses unconfigured adapter: "${item.adapter}"`);
    }
  }
  for (const slot of state.slotUsage.adapters) {
    if (!configured.has(slot.adapter)) {
      errors.push(`Slot usage references unconfigured adapter: "${slot.adapter}"`);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
