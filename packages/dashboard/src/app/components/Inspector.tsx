/**
 * The Issue Inspector drawer. Surfaces a session's per-runner panel (workflow
 * state, `controlled_by`, tmux session + liveness, last heartbeat, context
 * tokens, transcript path), links to the PR + worktree, the hook-event timeline,
 * and the attach affordances: Watch / Take control / Release + copy-command.
 */
import type { RunnerPanel, SessionEvent } from "../../wire.ts";
import { ago } from "../format.ts";
import { CopyCommand } from "./CopyCommand.tsx";

/** Events that record a verification gate outcome — pulled out as evidence. */
function isVerificationEvent(type: string): boolean {
  return /gate|verify|verification|check/i.test(type);
}

export function Inspector({
  panel,
  events,
  now,
  transcriptUrl,
  onClose,
  onWatch,
  onTakeControl,
  onRelease,
}: {
  panel: RunnerPanel;
  events: SessionEvent[];
  now?: number;
  transcriptUrl?: string;
  onClose?: () => void;
  onWatch?: (session: string) => void;
  onTakeControl?: (session: string) => void;
  onRelease?: (session: string) => void;
}) {
  const verification = events.filter((e) => isVerificationEvent(e.type));
  return (
    <aside className="inspector" role="dialog" aria-label={`Inspector for ${panel.session}`}>
      <div className="inspector-head">
        <h3>
          #{panel.epic ?? "—"} · {panel.repo}
        </h3>
        <button type="button" className="inspector-close" onClick={() => onClose?.()}>
          close
        </button>
      </div>

      <dl className="runner-panel">
        <dt>state</dt>
        <dd>{panel.state}</dd>
        <dt>controlled by</dt>
        <dd className={panel.controlledBy === "human" ? "human" : "middle"}>
          {panel.controlledBy}
        </dd>
        <dt>tmux session</dt>
        <dd>
          {panel.session}{" "}
          <span className={panel.alive ? "alive" : "dead"}>
            {panel.alive ? "● live" : "○ gone"}
          </span>
        </dd>
        <dt>last heartbeat</dt>
        <dd>{ago(panel.lastHeartbeat, now)} ago</dd>
        <dt>context tokens</dt>
        <dd>{panel.contextTokens ?? "—"}</dd>
        <dt>transcript</dt>
        <dd>
          {panel.transcriptPath ? (
            transcriptUrl ? (
              <a href={transcriptUrl}>{panel.transcriptPath}</a>
            ) : (
              <code>{panel.transcriptPath}</code>
            )
          ) : (
            "—"
          )}
        </dd>
        <dt>worktree</dt>
        <dd>{panel.worktreePath ? <code>{panel.worktreePath}</code> : "—"}</dd>
        <dt>PR</dt>
        <dd>{panel.prNumber !== null ? `#${panel.prNumber}` : "—"}</dd>
      </dl>

      <div className="inspector-actions">
        <button type="button" onClick={() => onWatch?.(panel.session)}>
          watch
        </button>
        <button
          type="button"
          onClick={() => onTakeControl?.(panel.session)}
          disabled={panel.controlledBy === "human"}
        >
          take control
        </button>
        <button
          type="button"
          onClick={() => onRelease?.(panel.session)}
          disabled={panel.controlledBy === "middle"}
        >
          release
        </button>
      </div>
      <div className="inspector-copy">
        <CopyCommand command={panel.attachCommands.watch} label="watch" />
        <CopyCommand command={panel.attachCommands.control} label="control" />
      </div>

      <section className="verification">
        <h4>Verification evidence</h4>
        {verification.length === 0 ? (
          <p className="empty">No verification events recorded yet.</p>
        ) : (
          <ul>
            {verification.map((e, i) => (
              <li key={`${e.ts}-${i}`}>
                {e.type} · {ago(e.ts, now)} ago
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="timeline">
        <h4>Event timeline</h4>
        {events.length === 0 ? (
          <p className="empty">No events yet.</p>
        ) : (
          <ol>
            {events.map((e, i) => (
              <li key={`${e.ts}-${i}`}>
                <span className="ev-type">{e.type}</span>{" "}
                <span className="ev-ago">{ago(e.ts, now)} ago</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </aside>
  );
}
