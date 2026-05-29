/**
 * Per-CLI adapter selection — the build spec's four-rule algorithm
 * (build spec → "Phase 3" → "Adapter selection", and the `recommending-github-issues`
 * skill). The canonical TS encoding of the rules the recommender applies in prose
 * when it fills the state issue's Ready table, and the resolver `mm dispatch`
 * uses to honor an `agent:<name>` label.
 *
 * Rules, in order:
 *  1. An explicit `agent:<name>` label on the Epic overrides everything.
 *  2. Otherwise `config.default_adapter`.
 *  3. If the chosen adapter is rate-limited AND the task is portable (and the
 *     choice was not pinned by a label), switch to an available adapter.
 *  4. Otherwise leave it as chosen and mark `skip` — auto-dispatch skips a
 *     rate-limited adapter until its limit resets.
 *
 * A label pin is absolute: rule 3 never switches away from a human's explicit
 * `agent:<name>` choice (a pinned-but-rate-limited adapter is skipped, not
 * switched). See `planning/issues/60/decisions.md` for why.
 */
export type AdapterSelectionInput = {
  /** Labels on the Epic; an `agent:<name>` among them pins the adapter. */
  labels: readonly string[];
  /** `config.global.default_adapter`. */
  defaultAdapter: string;
  /**
   * The dispatchable adapter names a choice is validated against — the caller's
   * already-filtered set of configured, enabled, and implemented adapters. A
   * label/default outside this set throws.
   */
  available: readonly string[];
  /** Adapters whose rate limit has not yet reset. Defaults to none. */
  rateLimited?: ReadonlySet<string>;
  /** Whether the task can run on any adapter (the recommender's judgment). Defaults to false. */
  portable?: boolean;
};

/** The resolved adapter plus how it was chosen and whether dispatch should skip it. */
export type AdapterSelection = {
  /** The selected adapter name. */
  adapter: string;
  /** How it was chosen: a label pin, the default, or a rate-limit switch. */
  source: "label" | "default" | "switched";
  /** True when the chosen adapter is rate-limited and could not be switched — auto-dispatch skips it. */
  skip: boolean;
  /** One-line, human-readable rationale for the decision. */
  reason: string;
};

const AGENT_LABEL_RE = /^agent:(.+)$/;

/** Extract the distinct `agent:<name>` overrides from a label set. */
function parseOverrides(labels: readonly string[]): string[] {
  const names = labels
    .map((label) => AGENT_LABEL_RE.exec(label.trim())?.[1]?.trim())
    .filter((name): name is string => name !== undefined && name.length > 0);
  return [...new Set(names)];
}

/**
 * Resolve which adapter an Epic should dispatch on, applying the four selection
 * rules. Throws on an unresolvable configuration — conflicting `agent:` labels,
 * or a label/default naming an adapter that isn't in `available` — so a
 * misconfiguration surfaces loudly at dispatch rather than silently picking the
 * wrong CLI.
 */
export function selectAdapter(input: AdapterSelectionInput): AdapterSelection {
  const available = new Set(input.available);
  const rateLimited = input.rateLimited ?? new Set<string>();
  const portable = input.portable ?? false;

  const overrides = parseOverrides(input.labels);
  if (overrides.length > 1) {
    throw new Error(
      `conflicting adapter labels: ${overrides.map((name) => `agent:${name}`).join(", ")}`,
    );
  }

  const pinned = overrides.length === 1;
  const chosen = pinned ? overrides[0]! : input.defaultAdapter;
  if (!available.has(chosen)) {
    const list = [...available].join(", ") || "(none)";
    throw new Error(
      pinned
        ? `agent:${chosen} label names an adapter that is not configured (available: ${list})`
        : `default adapter "${chosen}" is not configured (available: ${list})`,
    );
  }

  if (!rateLimited.has(chosen)) {
    return {
      adapter: chosen,
      source: pinned ? "label" : "default",
      skip: false,
      reason: pinned ? `pinned by agent:${chosen} label` : `default adapter ${chosen}`,
    };
  }

  // The chosen adapter is rate-limited. A label pin is never switched away from.
  if (!pinned && portable) {
    const alternative = input.available.find((name) => name !== chosen && !rateLimited.has(name));
    if (alternative !== undefined) {
      return {
        adapter: alternative,
        source: "switched",
        skip: false,
        reason: `${chosen} rate-limited; switched to ${alternative} (portable task)`,
      };
    }
  }

  return {
    adapter: chosen,
    source: pinned ? "label" : "default",
    skip: true,
    reason: pinned
      ? `pinned ${chosen} is rate-limited; left for auto-dispatch to skip until reset`
      : `${chosen} rate-limited${portable ? " with no available alternative" : " and task not portable"}; left for auto-dispatch to skip until reset`,
  };
}
