/**
 * One IN FLIGHT runner inside a repo's expansion: the Epic/adapter/progress,
 * Watch / Take control buttons, and the copy-paste-accurate `tmux attach`
 * command. `controlled_by = human` is surfaced so the operator sees who's
 * driving. Opening the row drills into the Inspector.
 */
import type { RunnerSummary } from "../../wire.ts";
import { ago } from "../format.ts";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
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
      <Button
        variant="link"
        className="runner-open h-auto justify-start p-0 text-foreground"
        onClick={() => onOpenInspector?.(runner.session)}
      >
        <EpicRef epicNumber={runner.epic} epicRef={runner.epicRef} fallback="#—" /> ·{" "}
        {runner.adapter} · {runner.progress} · {ago(runner.lastHeartbeat, now)} ago
      </Button>
      {runner.controlledBy === "human" ? <Badge variant="warning">human</Badge> : null}
      <span className="runner-actions flex gap-2">
        <Button variant="secondary" size="sm" onClick={() => onWatch?.(runner.session)}>
          watch
        </Button>
        <Button variant="secondary" size="sm" onClick={() => onTakeControl?.(runner.session)}>
          take control
        </Button>
      </span>
      <CopyCommand command={runner.attachCommands.watch} label="attach" />
    </li>
  );
}
