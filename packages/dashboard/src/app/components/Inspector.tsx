import type { RunnerPanel, SessionEvent } from "../../wire.ts";
import { ago } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useMediaQuery } from "../useMediaQuery.ts";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "./ui/sheet.tsx";
import { CopyCommand } from "./CopyCommand.tsx";
import { EpicRef } from "./EpicRef.tsx";

/** Events that record a verification gate outcome — pulled out as evidence. */
function isVerificationEvent(type: string): boolean {
  return /gate|verify|verification|check/i.test(type);
}

/**
 * The Issue Inspector drawer, rendered as a shadcn `Sheet` (Radix Dialog) instead
 * of a fixed-position `<aside>`. Surfaces a session's per-runner `panel` (workflow
 * state, `controlled_by`, tmux session + liveness, last heartbeat, context
 * tokens, transcript path), links to the PR + worktree, the hook-event `events`
 * timeline, and the attach affordances. `now` anchors relative timestamps;
 * `transcriptUrl` links the transcript. The optional `onWatch`/`onTakeControl`/
 * `onRelease` callbacks each receive the session id.
 *
 * The caller renders this only while a session is selected, so the Sheet is
 * controlled-`open`; dismissing it (Escape, overlay click, or the close button)
 * routes through Radix `onOpenChange` and invokes `onClose` — the consumer owns
 * teardown (clearing its selected-session state). The anchor `side` is `right` on
 * desktop and `bottom` on small viewports (#222).
 */
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
  // Anchor the Sheet to the right edge on desktop (≥1024px) and slide it up from
  // the bottom on narrower viewports (#222). The breakpoint must branch in JS, so
  // it reads the media query rather than a CSS-only utility.
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const side = isDesktop ? "right" : "bottom";
  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose?.();
      }}
    >
      <SheetContent
        side={side}
        aria-label={`Inspector for ${panel.session}`}
        aria-describedby={undefined}
        className={cn(
          "inspector w-full gap-2 text-sm",
          side === "right" ? "sm:max-w-md" : "max-h-[85vh]",
        )}
      >
        <SheetHeader className="inspector-head">
          <SheetTitle>
            <EpicRef epicNumber={panel.epic} epicRef={panel.epicRef} fallback="#—" /> · {panel.repo}
          </SheetTitle>
        </SheetHeader>

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
            <Badge
              variant={panel.alive ? "success" : "destructive"}
              aria-label={panel.alive ? "session alive" : "session ended"}
            >
              {/* The glyph stays visual; the Badge's aria-label carries the
                  semantic so screenreaders don't announce "black circle". */}
              <span aria-hidden="true">{panel.alive ? "● live" : "○ gone"}</span>
            </Badge>
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

        <div className="inspector-actions flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => onWatch?.(panel.session)}>
            watch
          </Button>
          <Button
            size="sm"
            onClick={() => onTakeControl?.(panel.session)}
            disabled={panel.controlledBy === "human"}
          >
            take control
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onRelease?.(panel.session)}
            disabled={panel.controlledBy === "middle"}
          >
            release
          </Button>
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
      </SheetContent>
    </Sheet>
  );
}
