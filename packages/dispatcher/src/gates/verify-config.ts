/**
 * Verification gate framework (Phase 6, build-spec item #30).
 *
 * A repo declares its verification gates in `<worktree>/.middle/verify.toml`
 * (the same per-repo operational location as `.middle/config.toml`). This module
 * loads, validates, and resolves that declaration. The schema's source of truth
 * is `schemas/verify.v1.md`; this code conforms to it.
 *
 * Gates are addressable per phase: the checkbox-revert reconciler runs "phase
 * N's gates" via {@link gatesForPhase}, where N is the sub-issue whose checkbox
 * transitioned `[ ] → [x]`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

/** Default per-gate wall-clock timeout (seconds) when none is declared. */
export const DEFAULT_GATE_TIMEOUT_SECONDS = 300;

/** A gate's category: a plain `unit` gate, or an `integration` gate that exercises the real product. */
export type GateCategory = "unit" | "integration";

/** The allowed `category` values (default `unit` when omitted). */
export const GATE_CATEGORIES: readonly GateCategory[] = ["unit", "integration"];

/** A single resolved gate: a named command with a timeout and optional phase scope. */
export type Gate = {
  name: string;
  command: string;
  /** Resolved timeout in seconds (default applied). */
  timeoutSeconds: number;
  /** Sub-issue numbers this gate is scoped to; undefined = runs for every phase. */
  phases?: number[];
  /**
   * Gate category (Epic #143, sub-issue #145). `integration` gates exercise the
   * running product (boot/serve/invoke the real path), distinct from `unit` gates.
   * Defaults to `unit`.
   */
  category: GateCategory;
};

export type VerifyConfig = {
  gates: Gate[];
};

/** Thrown for any missing/malformed `verify.toml` — the dispatcher surfaces this loudly. */
export class VerifyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyConfigError";
  }
}

/** The canonical per-repo path: `<worktreeRoot>/.middle/verify.toml`. */
export function verifyConfigPath(worktreeRoot: string): string {
  return join(worktreeRoot, ".middle", "verify.toml");
}

const KNOWN_GATE_KEYS = new Set(["name", "command", "timeout_seconds", "phases", "category"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateGate(raw: unknown, index: number): Gate {
  const where = `gate #${index + 1}`;
  if (!isPlainObject(raw)) {
    throw new VerifyConfigError(`${where}: each [[gate]] must be a table`);
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_GATE_KEYS.has(key)) {
      throw new VerifyConfigError(
        `${where}: unknown key "${key}" (did you mean one of name, command, timeout_seconds, phases?)`,
      );
    }
  }

  const { name, command, timeout_seconds: timeoutSeconds, phases, category } = raw;

  if (typeof name !== "string" || name.trim() === "") {
    throw new VerifyConfigError(`${where}: "name" is required and must be a non-empty string`);
  }
  if (typeof command !== "string" || command.trim() === "") {
    throw new VerifyConfigError(
      `gate "${name}": "command" is required and must be a non-empty string`,
    );
  }

  let resolvedTimeout = DEFAULT_GATE_TIMEOUT_SECONDS;
  if (timeoutSeconds !== undefined) {
    if (
      typeof timeoutSeconds !== "number" ||
      !Number.isFinite(timeoutSeconds) ||
      timeoutSeconds <= 0
    ) {
      throw new VerifyConfigError(`gate "${name}": "timeout_seconds" must be a positive number`);
    }
    resolvedTimeout = timeoutSeconds;
  }

  let resolvedPhases: number[] | undefined;
  if (phases !== undefined) {
    // A present-but-empty `phases = []` matches no sub-issue, silently disabling
    // the gate for every phase — the failure mode the loud-validation contract
    // exists to prevent. To run a gate everywhere, omit `phases` entirely.
    if (
      !Array.isArray(phases) ||
      phases.length === 0 ||
      !phases.every((p) => typeof p === "number" && Number.isInteger(p) && p > 0)
    ) {
      throw new VerifyConfigError(
        `gate "${name}": "phases" must be a non-empty array of positive integers (omit it to run for every phase)`,
      );
    }
    resolvedPhases = phases as number[];
  }

  let resolvedCategory: GateCategory = "unit";
  if (category !== undefined) {
    if (typeof category !== "string" || !GATE_CATEGORIES.includes(category as GateCategory)) {
      throw new VerifyConfigError(
        `gate "${name}": "category" must be one of ${GATE_CATEGORIES.map((c) => `"${c}"`).join(", ")}`,
      );
    }
    resolvedCategory = category as GateCategory;
  }

  const gate: Gate = {
    name: name.trim(),
    command,
    timeoutSeconds: resolvedTimeout,
    category: resolvedCategory,
  };
  if (resolvedPhases !== undefined) gate.phases = resolvedPhases;
  return gate;
}

/** Parse + validate the TOML body of a `verify.toml`. Throws {@link VerifyConfigError}. */
export function parseVerifyConfig(toml: string): VerifyConfig {
  let parsed: unknown;
  try {
    parsed = parseToml(toml);
  } catch (err) {
    throw new VerifyConfigError(`verify.toml is not valid TOML: ${(err as Error).message}`);
  }

  const rawGates = isPlainObject(parsed) ? parsed.gate : undefined;
  if (!Array.isArray(rawGates) || rawGates.length === 0) {
    throw new VerifyConfigError("verify.toml must declare at least one [[gate]]");
  }

  const gates = rawGates.map((g, i) => validateGate(g, i));

  const seen = new Set<string>();
  for (const gate of gates) {
    if (seen.has(gate.name)) {
      throw new VerifyConfigError(`duplicate gate name "${gate.name}" — gate names must be unique`);
    }
    seen.add(gate.name);
  }

  return { gates };
}

/** Load + validate `verify.toml` from disk. A missing/unreadable file fails loudly. */
export function loadVerifyConfig(path: string): VerifyConfig {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (err) {
    throw new VerifyConfigError(`could not read verify.toml at ${path}: ${(err as Error).message}`);
  }
  return parseVerifyConfig(contents);
}

/**
 * The gates to run for phase `subIssue`, in declared order: every gate whose
 * `phases` is absent (applies to all phases) or contains `subIssue`.
 */
export function gatesForPhase(config: VerifyConfig, subIssue: number): Gate[] {
  return config.gates.filter((g) => g.phases === undefined || g.phases.includes(subIssue));
}

/**
 * The `integration`-category gates in a config (Epic #143, sub-issue #145) — the
 * gates that exercise the real product. Lets callers (verify-on-stop, the
 * reviewer brief) recognise whether a repo declares an integration gate distinct
 * from its unit gates.
 */
export function integrationGates(config: VerifyConfig): Gate[] {
  return config.gates.filter((g) => g.category === "integration");
}
