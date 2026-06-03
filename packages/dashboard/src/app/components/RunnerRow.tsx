/**
 * One IN FLIGHT runner inside a repo's expansion: the Epic/adapter/progress,
 * Watch / Take control buttons, and the copy-paste-accurate `tmux attach`
 * command. `controlled_by = human` is surfaced so the operator sees who's
 * driving. Opening the row drills into the Inspector.
 */
import type { RunnerSummary } from "../../wire.ts";
import { ago } from "../format.ts";
import { CopyCommand } from "./CopyCommand.tsx";
import { EpicRef } from "./EpicRef.tsx";

export function RunnerRow({
  runner,
  now,
  onWatch,
  onTakeControl,
  onOpenInspector,
}: {
  runner: RunnerSummary;
  now?: number;
  onWatch?: (session: string) => void;
  onTakeControl?: (session: string) => void;
  onOpenInspector?: (session: string) => void;
}) {
  return (
    <li className="runner-row" data-session={runner.session}>
      <button
        type="button"
        className="runner-open"
        onClick={() => onOpenInspector?.(runner.session)}
      >
        <EpicRef epicNumber={runner.epic} epicRef={runner.epicRef} fallback="#—" /> ·{" "}
        {runner.adapter} · {runner.progress} · {ago(runner.lastHeartbeat, now)} ago
      </button>
      {runner.controlledBy === "human" ? <span className="badge human">human</span> : null}
      <span className="runner-actions">
        <button type="button" onClick={() => onWatch?.(runner.session)}>
          watch
        </button>
        <button type="button" onClick={() => onTakeControl?.(runner.session)}>
          take control
        </button>
      </span>
      <CopyCommand command={runner.attachCommands.watch} label="attach" />
    </li>
  );
}
