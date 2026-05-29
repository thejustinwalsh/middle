import {
  ANSWER_CLOSE,
  ANSWER_OPEN_RE,
  CONVERSATION_CLOSE,
  CONVERSATION_OPEN,
  DISPATCH_EVENT_CLOSE,
  DISPATCH_EVENT_OPEN_RE,
  EPIC_DOC_MARKER,
  META_CLOSE,
  META_OPEN,
  QUESTION_CLOSE,
  QUESTION_OPEN_RE,
  SUB_ISSUE_CLOSE,
  SUB_ISSUE_OPEN_RE,
} from "./markers.ts";
import type { AcceptanceItem, ConversationEntry, EpicFile, EpicMeta, SubIssue } from "./types.ts";

/**
 * Parse an Epic file's body into a typed model. Strict on markers + attributes
 * (the structural contract), lenient on prose. Throws with a named-marker error
 * when a structural element is malformed so operators can diagnose from the
 * Epic file itself without log-tailing.
 *
 * Round-trip with `renderEpicFile` is byte-identical for any body the parser
 * accepts — that property test (`round-trip.test.ts`) is the load-bearing
 * guarantee the rest of the file-mode design depends on.
 */
export function parseEpicFile(body: string): EpicFile {
  if (!body.startsWith(EPIC_DOC_MARKER)) {
    throw new Error(`Epic file missing document marker (${EPIC_DOC_MARKER})`);
  }
  const lines = body.split("\n");
  return {
    title: parseTitle(lines),
    meta: parseMeta(lines),
    context: sectionBody(lines, "Context"),
    acceptanceCriteria: parseAcceptance(sectionBody(lines, "Acceptance criteria")),
    subIssues: parseSubIssues(sectionBody(lines, "Sub-issues")),
    conversation: parseConversation(lines),
  };
}

function parseTitle(lines: string[]): string {
  const h1 = lines.find((l) => l.startsWith("# "));
  if (!h1) throw new Error("Epic file missing H1 title line");
  return h1.slice(2).trim();
}

function parseMeta(lines: string[]): EpicMeta {
  const openIdx = lines.findIndex((l) => l.trim() === META_OPEN);
  if (openIdx === -1) {
    throw new Error(`Epic file missing meta block (${META_OPEN}…${META_CLOSE})`);
  }
  const closeIdx = lines.findIndex((l, i) => i > openIdx && l.trim() === META_CLOSE);
  if (closeIdx === -1) throw new Error("Meta block not closed");
  const meta: EpicMeta = { slug: "" };
  for (const line of lines.slice(openIdx + 1, closeIdx)) {
    const m = /^([a-z_-]+):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const [, key, raw] = m;
    switch (key) {
      case "slug":
        meta.slug = raw!;
        break;
      case "adapter":
        meta.adapter = raw!;
        break;
      case "complexity_ceiling":
        meta.complexityCeiling = Number(raw);
        break;
      case "approved":
        meta.approved = raw === "true";
        break;
      case "labels":
        meta.labels = parseArray(raw!);
        break;
      case "blocked-by":
        meta.blockedBy = parseArray(raw!);
        break;
      case "pr":
        meta.pr = Number(raw);
        break;
      case "closed":
        meta.closed = raw === "true";
        break;
    }
  }
  if (!meta.slug) throw new Error("Epic meta missing required `slug` key");
  return meta;
}

function parseArray(raw: string): string[] {
  const stripped = raw.trim().replace(/^\[|\]$/g, "");
  return stripped
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function sectionBody(lines: string[], heading: string): string {
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return "";
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end === -1) {
    // Sub-issues is the last `## ` section before the conversation marker —
    // stop at CONVERSATION_OPEN so the conversation block isn't swallowed.
    end = lines.findIndex((l, i) => i > start && l.trim() === CONVERSATION_OPEN);
    if (end === -1) end = lines.length;
  }
  return lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
}

function parseAcceptance(body: string): AcceptanceItem[] {
  const out: AcceptanceItem[] = [];
  for (const line of body.split("\n")) {
    const m = /^- \[([ x])\]\s+(.+)$/.exec(line);
    if (m) out.push({ checked: m[1] === "x", text: m[2]!.trim() });
  }
  return out;
}

function parseSubIssues(body: string): SubIssue[] {
  const out: SubIssue[] = [];
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length) {
    const open = SUB_ISSUE_OPEN_RE.exec(lines[i]!.trim());
    if (!open) {
      i++;
      continue;
    }
    const id = Number(open[1]);
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() !== SUB_ISSUE_CLOSE) j++;
    if (j >= lines.length) {
      throw new Error(`Sub-issue id=${id} not closed (expected ${SUB_ISSUE_CLOSE})`);
    }
    const inner = lines.slice(i + 1, j);
    const cb = /^- \[([ x])\]\s+\*\*(.+?)\*\*(.*)$/.exec(inner[0] ?? "");
    if (!cb) {
      throw new Error(`Sub-issue id=${id} missing canonical "- [ ] **N — title**" line`);
    }
    const checked = cb[1] === "x";
    const title = cb[2]!.trim();
    const provenance = (cb[3] ?? "").trim() || undefined;
    // Body lines are indented by two spaces in the canonical form; strip the
    // leading indent on read so the typed model holds the prose verbatim.
    const subBody = inner
      .slice(1)
      .map((l) => l.replace(/^ {2}/, ""))
      .join("\n")
      .trim();
    out.push({ id, checked, title, body: subBody, provenance });
    i = j + 1;
  }
  return out;
}

function parseConversation(lines: string[]): ConversationEntry[] {
  const start = lines.findIndex((l) => l.trim() === CONVERSATION_OPEN);
  if (start === -1) return [];
  const end = lines.findIndex((l, i) => i > start && l.trim() === CONVERSATION_CLOSE);
  if (end === -1) throw new Error("Conversation block not closed");
  const inner = lines.slice(start + 1, end);
  const entries: ConversationEntry[] = [];
  let i = 0;
  while (i < inner.length) {
    const line = inner[i]!.trim();
    if (!line) {
      i++;
      continue;
    }

    const dm = DISPATCH_EVENT_OPEN_RE.exec(line);
    if (dm) {
      const close = inner.findIndex((l, k) => k > i && l.trim() === DISPATCH_EVENT_CLOSE);
      if (close === -1) throw new Error("dispatch-event block not closed");
      entries.push({
        kind: "dispatch-event",
        ts: dm[1]!,
        eventKind: dm[2]!,
        body: inner
          .slice(i + 1, close)
          .join("\n")
          .trim(),
      });
      i = close + 1;
      continue;
    }

    const qm = QUESTION_OPEN_RE.exec(line);
    if (qm) {
      const close = inner.findIndex((l, k) => k > i && l.trim() === QUESTION_CLOSE);
      if (close === -1) throw new Error("question block not closed");
      const block = inner.slice(i + 1, close);
      const answerStart = block.findIndex((l) => ANSWER_OPEN_RE.test(l.trim()));
      const questionBody = (answerStart === -1 ? block : block.slice(0, answerStart))
        .join("\n")
        .trim();
      let answer: { body: string } | undefined;
      if (answerStart !== -1) {
        const answerClose = block.findIndex((l, k) => k > answerStart && l.trim() === ANSWER_CLOSE);
        if (answerClose === -1) throw new Error("answer block not closed");
        const answerBody = block
          .slice(answerStart + 1, answerClose)
          .filter((l) => !l.trim().startsWith("<!--"))
          .join("\n")
          .trim();
        if (answerBody) answer = { body: answerBody };
      }
      entries.push({
        kind: "question",
        id: Number(qm[1]),
        status: qm[2] as "open" | "resolved",
        ts: qm[3]!,
        questionKind: qm[4],
        body: questionBody,
        answer,
      });
      i = close + 1;
      continue;
    }

    i++;
  }
  return entries;
}
