import type { RepoConfig } from "@middle/core";
import type { ParsedState, ValidationResult } from "./schema.v1.ts";

// Enforces the schema doc's "Validation rules". Rules 1-3 and 6 (markers,
// section presence/order, Ready table header, documented empty states) are
// structural and already guaranteed by a successful parseStateIssue; this
// function re-checks the rules that depend on field values and config:
// rule 4 (#N reference shape), rule 5 (configured adapters), rule 7 (ISO 8601).

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const EPIC_REF_RE = /^#\d+\s+\S/;
const ISSUE_REF_RE = /^#\d+$/;

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
      errors.push(`Ready row epic is not a "#<n> <title>" reference: "${row.epic}"`);
    }
  }
  for (const item of state.blocked) {
    // blocker is "#<n>" for an issue, or "`<description>`" for a non-issue blocker.
    if (item.blocker.startsWith("#") && !ISSUE_REF_RE.test(item.blocker)) {
      errors.push(`Blocked blocker is not a valid issue reference: "${item.blocker}"`);
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
