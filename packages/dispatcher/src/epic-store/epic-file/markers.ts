/**
 * Every HTML-comment marker the Epic-file format uses. The marker IS the
 * structural contract — never change the bytes here without bumping the
 * version suffix (`v1`) on the document marker.
 *
 * Convention mirrors the state-issue v1 marker (`<!-- AGENT-QUEUE-STATE v1 -->`
 * in `packages/state-issue/src/constants.ts:4`): marker + version, exact-match
 * required by the parser. Sub-markers carry attributes (`id=`, `status=`, `ts=`)
 * the renderer formats from the parsed model — agents/humans only write
 * *between* markers, never inside the strict attribute lines (closes #180's
 * class of writer/parser drift).
 */

export const EPIC_DOC_MARKER = "<!-- middle:epic v1 -->";

export const META_OPEN = "<!-- middle:meta";
export const META_CLOSE = "-->";

export const SUB_ISSUE_OPEN_RE = /^<!-- middle:sub-issue id=(\d+) -->$/;
export const SUB_ISSUE_CLOSE = "<!-- /middle:sub-issue -->";

export const CONVERSATION_OPEN = "<!-- middle:conversation -->";
export const CONVERSATION_CLOSE = "<!-- /middle:conversation -->";

export const QUESTION_OPEN_RE =
  /^<!-- middle:question id=(\d+) status=(open|resolved) ts=([\dT:Z.-]+)(?: kind=(\w+))? -->$/;
export const QUESTION_CLOSE = "<!-- /middle:question -->";

export const ANSWER_OPEN_RE = /^<!-- middle:answer for=(\d+) -->$/;
export const ANSWER_CLOSE = "<!-- /middle:answer -->";

export const DISPATCH_EVENT_OPEN_RE = /^<!-- middle:dispatch-event ts=([\dT:Z.-]+) kind=(\w+) -->$/;
export const DISPATCH_EVENT_CLOSE = "<!-- /middle:dispatch-event -->";

export const PARSE_ERROR_OPEN_RE = /^<!-- middle:parse-error ts=([\dT:Z.-]+) -->$/;
export const PARSE_ERROR_CLOSE = "<!-- /middle:parse-error -->";

/** Section headings — strict spelling + order. */
export const SECTIONS = ["Context", "Acceptance criteria", "Sub-issues"] as const;

/** Placeholder content the renderer writes inside an empty answer block. */
export const ANSWER_PLACEHOLDER =
  "<!-- Human edits here. File-watcher fires resume on this section becoming non-empty. -->";
