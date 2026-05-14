import {
  CLOSE_MARKER,
  IN_FLIGHT_EMPTY,
  OPEN_MARKER,
  OWNERS_LINE,
  READY_EMPTY_ROW,
  READY_TABLE_HEADER,
  READY_TABLE_SEPARATOR,
  SECTION_NAMES,
} from "./constants.ts";
import type { ParsedState } from "./schema.v1.ts";

function renderSection(name: string, content: string): string {
  return content === "" ? `## ${name}` : `## ${name}\n\n${content}`;
}

/** Render a ParsedState to a canonical, schema-conforming issue body. */
export function renderStateIssue(state: ParsedState): string {
  const metadata = `<!-- generated: ${state.generated} · run: ${state.runId} · interval: ${state.intervalMinutes}m -->`;

  const ready = [
    READY_TABLE_HEADER,
    READY_TABLE_SEPARATOR,
    ...(state.readyToDispatch.length === 0
      ? [READY_EMPTY_ROW]
      : state.readyToDispatch.map(
          (r) => `| ${r.rank} | ${r.epic} | ${r.adapter} | ${r.subIssues} | ${r.reason} |`,
        )),
  ].join("\n");

  const needs = state.needsHumanInput
    .map((n) => `- **#${n.issue} ${n.label}** — ${n.oneLiner} · ${n.link}`)
    .join("\n");

  const blocked = state.blocked
    .map((b) => `- **#${b.issue}** waiting on ${b.blocker} · ${b.context}`)
    .join("\n");

  const inFlight =
    state.inFlight.length === 0
      ? IN_FLIGHT_EMPTY
      : state.inFlight
          .map(
            (i) =>
              `- **#${i.issue}** · ${i.adapter} · ${i.progress} · last heartbeat ${i.lastHeartbeat} · [tmux: ${i.tmuxSession}]`,
          )
          .join("\n");

  const excluded = state.excluded
    .map((e) => `- **#${e.issue}** ${e.category} — ${e.detail}`)
    .join("\n");

  const rateLimits = [
    `- claude: ${state.rateLimits.claude}`,
    `- codex: ${state.rateLimits.codex}`,
    `- github: ${state.rateLimits.github}`,
  ].join("\n");

  const slotUsage = [
    ...state.slotUsage.adapters.map((a) => `- ${a.adapter}: ${a.used}/${a.max}`),
    `- total: ${state.slotUsage.total.used}/${state.slotUsage.total.max}`,
    `- global: ${state.slotUsage.global.used}/${state.slotUsage.global.max}`,
  ].join("\n");

  const sectionContent = [ready, needs, blocked, inFlight, excluded, rateLimits, slotUsage];

  return [
    `${OPEN_MARKER}\n${metadata}\n${OWNERS_LINE}`,
    ...SECTION_NAMES.map((name, i) => renderSection(name, sectionContent[i]!)),
    CLOSE_MARKER,
  ].join("\n\n");
}
