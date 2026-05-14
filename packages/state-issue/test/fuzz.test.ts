import { describe, expect, test } from "bun:test";
import { isParseError, parseStateIssue } from "../src/parser.ts";
import { renderStateIssue } from "../src/renderer.ts";
import type {
  AdapterSlotUsage,
  BlockedItem,
  ExcludedItem,
  InFlightItem,
  NeedsHumanItem,
  ParsedState,
  ReadyRow,
} from "../src/schema.v1.ts";

// Deterministic, seeded fuzz: each iteration uses a fresh PRNG seeded with
// `BASE_SEED + i`, so any failure is reproducible from the reported seed.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const HEX = "0123456789abcdef";
const ADAPTERS = ["claude", "codex"] as const;
const EXCLUDED_CATEGORIES = [
  "assigned to human",
  "needs-design label",
  "acceptance criteria missing",
  "no open sub-issues",
  "archived",
  "out of scope",
] as const;

class Rng {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  bool(): boolean {
    return this.next() < 0.5;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]!;
  }
  // Safe text: alphanumerics + interior spaces, no leading/trailing space.
  // Excludes every structural separator (| \n · ** — ]), so it round-trips
  // in any field regardless of which section it lands in.
  text(minLen: number, maxLen: number): string {
    const len = this.int(minLen, maxLen);
    let out = "";
    for (let i = 0; i < len; i++) {
      const space = i > 0 && i < len - 1 && this.next() < 0.15;
      out += space ? " " : ALNUM[Math.floor(this.next() * ALNUM.length)];
    }
    return out;
  }
  hex(len: number): string {
    let out = "";
    for (let i = 0; i < len; i++) out += HEX[Math.floor(this.next() * HEX.length)];
    return out;
  }
  iso(): string {
    const y = this.int(2024, 2027);
    const mo = String(this.int(1, 12)).padStart(2, "0");
    const d = String(this.int(1, 28)).padStart(2, "0");
    const h = String(this.int(0, 23)).padStart(2, "0");
    const mi = String(this.int(0, 59)).padStart(2, "0");
    const s = String(this.int(0, 59)).padStart(2, "0");
    return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  }
}

function genReadyRow(rng: Rng, rank: number): ReadyRow {
  return {
    rank,
    epic: `#${rng.int(1, 9999)} ${rng.text(1, 40)}`,
    adapter: rng.pick(ADAPTERS),
    subIssues: rng.int(1, 12),
    reason: rng.text(1, 60),
  };
}

function genNeeds(rng: Rng): NeedsHumanItem {
  return {
    issue: rng.int(1, 9999),
    label: rng.text(1, 20),
    oneLiner: rng.text(1, 50),
    link: `[${rng.text(1, 10)}](https://example.com/${rng.int(1, 9999)})`,
  };
}

function genBlocked(rng: Rng): BlockedItem {
  return {
    issue: rng.int(1, 9999),
    blocker: rng.bool() ? `#${rng.int(1, 9999)}` : `\`${rng.text(1, 20)}\``,
    context: rng.text(1, 40),
  };
}

function genInFlight(rng: Rng): InFlightItem {
  return {
    issue: rng.int(1, 9999),
    adapter: rng.pick(ADAPTERS),
    progress: rng.bool() ? "running" : `sub-issue ${rng.int(1, 9)}/${rng.int(1, 12)}`,
    lastHeartbeat: `${rng.int(1, 59)}${rng.pick(["s", "m", "h"])} ago`,
    tmuxSession: `middle-${rng.int(1, 9999)}`,
  };
}

function genExcluded(rng: Rng): ExcludedItem {
  return {
    issue: rng.int(1, 9999),
    category: rng.pick(EXCLUDED_CATEGORIES),
    detail: rng.text(1, 40),
  };
}

function genArray<T>(rng: Rng, max: number, gen: (i: number) => T): T[] {
  return Array.from({ length: rng.int(0, max) }, (_, i) => gen(i));
}

function genState(rng: Rng): ParsedState {
  const adapters: AdapterSlotUsage[] = ADAPTERS.filter(() => rng.bool()).map((adapter) => ({
    adapter,
    used: rng.int(0, 9),
    max: rng.int(0, 9),
  }));
  return {
    version: 1,
    generated: rng.iso(),
    runId: rng.hex(8),
    intervalMinutes: rng.int(1, 1440),
    readyToDispatch: genArray(rng, 4, (i) => genReadyRow(rng, i + 1)),
    needsHumanInput: genArray(rng, 4, () => genNeeds(rng)),
    blocked: genArray(rng, 4, () => genBlocked(rng)),
    inFlight: genArray(rng, 4, () => genInFlight(rng)),
    excluded: genArray(rng, 4, () => genExcluded(rng)),
    rateLimits: {
      claude: rng.text(1, 40),
      codex: rng.text(1, 40),
      github: rng.text(1, 40),
    },
    slotUsage: {
      adapters,
      total: { used: rng.int(0, 20), max: rng.int(0, 20) },
      global: { used: rng.int(0, 40), max: rng.int(0, 40) },
    },
  };
}

const BASE_SEED = 0x5eed_0000;
const ITERATIONS = 10_000;

describe("parser/renderer round-trip fuzz", () => {
  test(
    `renders, parses, and re-renders ${ITERATIONS} random valid states byte-identically`,
    () => {
      let coveredAllEmpty = false;
      let coveredAllFull = false;

      for (let i = 0; i < ITERATIONS; i++) {
        const seed = BASE_SEED + i;
        const state = genState(new Rng(seed));

        if (
          state.readyToDispatch.length === 0 &&
          state.needsHumanInput.length === 0 &&
          state.blocked.length === 0 &&
          state.inFlight.length === 0 &&
          state.excluded.length === 0
        ) {
          coveredAllEmpty = true;
        }
        if (
          state.readyToDispatch.length > 0 &&
          state.needsHumanInput.length > 0 &&
          state.blocked.length > 0 &&
          state.inFlight.length > 0 &&
          state.excluded.length > 0
        ) {
          coveredAllFull = true;
        }

        const once = renderStateIssue(state);
        const parsed = parseStateIssue(once);
        if (isParseError(parsed)) {
          throw new Error(`seed ${seed}: parse failed — ${parsed.message}\n--- body ---\n${once}`);
        }
        if (!Bun.deepEquals(parsed, state)) {
          throw new Error(
            `seed ${seed}: parsed state differs from original\n` +
              `--- original ---\n${JSON.stringify(state, null, 2)}\n` +
              `--- parsed ---\n${JSON.stringify(parsed, null, 2)}`,
          );
        }
        const twice = renderStateIssue(parsed);
        if (twice !== once) {
          throw new Error(
            `seed ${seed}: round-trip not byte-identical\n` +
              `--- once ---\n${once}\n--- twice ---\n${twice}`,
          );
        }
      }

      // The fuzz space must actually exercise both the documented empty states
      // and fully-populated sections, not just one regime.
      expect(coveredAllEmpty).toBe(true);
      expect(coveredAllFull).toBe(true);
    },
    30_000,
  );
});
