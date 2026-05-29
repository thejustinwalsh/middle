import {
  ANSWER_CLOSE,
  ANSWER_PLACEHOLDER,
  CONVERSATION_CLOSE,
  CONVERSATION_OPEN,
  DISPATCH_EVENT_CLOSE,
  EPIC_DOC_MARKER,
  META_CLOSE,
  META_OPEN,
  QUESTION_CLOSE,
  SUB_ISSUE_CLOSE,
} from "./markers.ts";
import type { ConversationEntry, EpicFile, EpicMeta, SubIssue } from "./types.ts";

/**
 * Render an `EpicFile` to its canonical Markdown form. The output is the
 * byte-identical round-trip of the parser's input for any body the parser
 * accepts (see `round-trip.test.ts`).
 *
 * The renderer is the sole writer of strict-marker attribute lines (meta,
 * sub-issue, question/answer/dispatch-event). Agents/humans write between
 * markers but never inside the marker attributes — that single-writer rule
 * closes #180's class of writer/parser drift for the file path.
 */
export function renderEpicFile(epic: EpicFile): string {
  const parts: string[] = [];
  parts.push(EPIC_DOC_MARKER);
  parts.push(`# ${epic.title}`);
  parts.push("");
  parts.push(renderMeta(epic.meta));
  parts.push("");
  parts.push("## Context");
  parts.push("");
  parts.push(epic.context || "(empty)");
  parts.push("");
  parts.push("## Acceptance criteria");
  parts.push("");
  for (const a of epic.acceptanceCriteria) {
    parts.push(`- [${a.checked ? "x" : " "}] ${a.text}`);
  }
  if (epic.acceptanceCriteria.length > 0) parts.push("");
  parts.push("## Sub-issues");
  parts.push("");
  for (const s of epic.subIssues) {
    parts.push(...renderSubIssue(s));
    parts.push("");
  }
  parts.push(CONVERSATION_OPEN);
  if (epic.conversation.length > 0) {
    for (const e of epic.conversation) {
      parts.push("");
      parts.push(...renderConversationEntry(e));
    }
    parts.push("");
  }
  parts.push(CONVERSATION_CLOSE);
  return `${parts.join("\n")}\n`;
}

function renderMeta(m: EpicMeta): string {
  const out: string[] = [META_OPEN];
  out.push(`slug: ${m.slug}`);
  if (m.adapter !== undefined) out.push(`adapter: ${m.adapter}`);
  if (m.complexityCeiling !== undefined) out.push(`complexity_ceiling: ${m.complexityCeiling}`);
  if (m.approved !== undefined) out.push(`approved: ${m.approved}`);
  if (m.labels?.length) out.push(`labels: [${m.labels.join(", ")}]`);
  if (m.blockedBy?.length) out.push(`blocked-by: [${m.blockedBy.join(", ")}]`);
  if (m.pr !== undefined) out.push(`pr: ${m.pr}`);
  if (m.closed !== undefined) out.push(`closed: ${m.closed}`);
  out.push(META_CLOSE);
  return out.join("\n");
}

function renderSubIssue(s: SubIssue): string[] {
  const out = [`<!-- middle:sub-issue id=${s.id} -->`];
  const provenance = s.provenance ? ` ${s.provenance}` : "";
  out.push(`- [${s.checked ? "x" : " "}] **${s.title}**${provenance}`);
  if (s.body) {
    // Re-indent body by two spaces to match the canonical sub-issue prose form.
    out.push(
      s.body
        .split("\n")
        .map((l) => (l.length > 0 ? `  ${l}` : ""))
        .join("\n"),
    );
  }
  out.push(SUB_ISSUE_CLOSE);
  return out;
}

function renderConversationEntry(e: ConversationEntry): string[] {
  if (e.kind === "dispatch-event") {
    return [
      `<!-- middle:dispatch-event ts=${e.ts} kind=${e.eventKind} -->`,
      e.body,
      DISPATCH_EVENT_CLOSE,
    ];
  }
  if (e.kind === "question") {
    const kindAttr = e.questionKind ? ` kind=${e.questionKind}` : "";
    return [
      `<!-- middle:question id=${e.id} status=${e.status} ts=${e.ts}${kindAttr} -->`,
      e.body,
      "",
      `<!-- middle:answer for=${e.id} -->`,
      e.answer ? e.answer.body : ANSWER_PLACEHOLDER,
      ANSWER_CLOSE,
      QUESTION_CLOSE,
    ];
  }
  return [`<!-- middle:parse-error ts=${e.ts} -->`, e.body, `<!-- /middle:parse-error -->`];
}
