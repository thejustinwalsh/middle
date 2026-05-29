/**
 * Typed model for the Epic file format. `parseEpicFile` produces an `EpicFile`;
 * `renderEpicFile` consumes one. The two together hold the byte-identical
 * round-trip invariant — every field a renderer needs to emit must be on this
 * model (or be a stable derivation), so the parser preserves it.
 */

export type EpicFile = {
  /** From the H1 title line. */
  title: string;
  meta: EpicMeta;
  /** Verbatim prose body of `## Context`. */
  context: string;
  acceptanceCriteria: AcceptanceItem[];
  subIssues: SubIssue[];
  conversation: ConversationEntry[];
};

export type EpicMeta = {
  /** Canonical Epic reference (matches the file's stem, without `.md`). */
  slug: string;
  /** Adapter override (`claude` / `codex`); when absent, recommender picks via selectAdapter. */
  adapter?: string;
  /** Per-Epic override for the repo's complexity_ceiling. */
  complexityCeiling?: number;
  /** Stand-in for the GitHub `approved` label — file mode reads this. */
  approved?: boolean;
  /** Display labels (informational; no GitHub side-effect in file mode). */
  labels?: string[];
  /** Cross-Epic dependency slugs the recommender's graph builder reads. */
  blockedBy?: string[];
  /** Stamped by the dispatcher when the Epic's PR opens (durable backup for findEpicPr). */
  pr?: number;
  /** Marks an Epic as no longer in the open set (recommender skips). */
  closed?: boolean;
};

export type AcceptanceItem = {
  checked: boolean;
  text: string;
};

export type SubIssue = {
  /** Stable per-Epic numeric ID — appears in `<!-- middle:sub-issue id=N -->`. */
  id: number;
  checked: boolean;
  /** Title line content after the `- [ ] **` / `**` markers, e.g. `1 — Implement the CodexAdapter`. */
  title: string;
  /** Prose body — anything between the title line and the closing marker. */
  body: string;
  /**
   * Provenance suffix the agent appends to the title when checking the box,
   * e.g. `*(done in wf_… sha abc1234)*`. Preserved on round-trip.
   */
  provenance?: string;
};

export type ConversationEntry =
  | { kind: "dispatch-event"; ts: string; eventKind: string; body: string }
  | {
      kind: "question";
      id: number;
      status: "open" | "resolved";
      ts: string;
      /** "question" | "complexity"; absent for the default plain-question shape. */
      questionKind?: string;
      body: string;
      /** Populated when the human's answer block is non-empty (the resume trigger). */
      answer?: { body: string };
    }
  | { kind: "parse-error"; ts: string; body: string };
