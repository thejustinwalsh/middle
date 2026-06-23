import { useState } from "react";
import type { EpicCard } from "../../wire.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";
import { Progress } from "./ui/progress.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { EpicRef } from "./EpicRef.tsx";
import { chipVariantForState, StatusChip } from "./StatusChip.tsx";

/**
 * The Epic-card progress strip — a thin filled bar plus a mono `closed / total`
 * label, aligned to the right so the eye reads "3 of 4 done" instantly.
 */
function ProgressStrip({ closed, total }: { closed: number; total: number }) {
  const pct = total > 0 ? Math.round((closed / total) * 100) : 0;
  return (
    <div className="flex items-center gap-3" aria-label={`${closed} of ${total} sub-issues done`}>
      <Progress value={pct} className="h-1 flex-1" />
      <span className="whitespace-nowrap font-mono text-[11px] tabular-nums text-[color:var(--fg-muted)]">
        {closed} / {total}
      </span>
    </div>
  );
}

/**
 * The dispatch-row — an adapter picker + the dispatch button. Gated when the
 * adapter has no free slot or the Epic is already in flight. Works for both
 * github-mode Epics (numeric ref) and file-mode Epics (slug ref) — the route
 * accepts both forms since #240.
 */
function DispatchControl({
  card,
  adapters,
  onDispatch,
}: {
  card: EpicCard;
  adapters: string[];
  onDispatch: (repo: string, epicRef: string, adapter: string) => void;
}) {
  const [adapter, setAdapter] = useState(
    card.dispatch.recommendedAdapter ?? adapters[0] ?? "claude",
  );
  // An adapter absent from freeSlots has unknown availability — treat as no slot
  // (it isn't a configured/dispatchable adapter, so the server would reject it anyway).
  const slot = card.dispatch.freeSlots.find((s) => s.adapter === adapter);
  const noSlot = slot ? !slot.available : true;
  const disabled = card.dispatch.inFlight || noSlot;
  return (
    <div className="flex items-center justify-end gap-1.5 pt-1">
      <Select value={adapter} onValueChange={setAdapter} disabled={card.dispatch.inFlight}>
        <SelectTrigger
          aria-label="agent"
          className={cn(
            "h-7 w-36 border-[color:var(--border)] bg-[color:var(--panel-2)]",
            "font-mono text-[11.5px]",
          )}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {adapters.map((a) => (
            <SelectItem key={a} value={a} className="font-mono text-[12px]">
              {a}
              {a === card.dispatch.recommendedAdapter ? " ★" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        aria-label={`Dispatch Epic ${card.ref}`}
        disabled={disabled}
        className="h-7 px-3 text-[12px] font-medium"
        title={card.dispatch.inFlight ? "already in flight" : noSlot ? "no free slot" : ""}
        onClick={() => onDispatch(card.repo, card.ref, adapter)}
      >
        dispatch
      </Button>
    </div>
  );
}

/**
 * The Epic browse view — the dashboard's primary surface. Renders `epics` (a
 * repo's open Epic cards) with sub-issue progress, the agent working each (if
 * any), a high-value decision callout, and a force-dispatch control whose adapter
 * picker is drawn from `adapters` and defaults to the recommender's choice (an
 * empty `adapters` or `epics` simply renders empty/disabled). `onDispatch(repo,
 * epicRef, adapter)` fires synchronously from the dispatch button; `epicRef` is a
 * numeric string or a file-mode slug — the server accepts both since #240. The
 * optional `onOpenInspector` receives a session id. The repo filter lives in
 * {@link App}; this component renders the chosen repo's cards.
 */
export function Epics({
  epics,
  adapters,
  onDispatch,
  onOpenInspector,
}: {
  epics: EpicCard[];
  adapters: string[];
  onDispatch: (repo: string, epicRef: string, adapter: string) => void;
  onOpenInspector?: (session: string) => void;
}) {
  return (
    <section className="flex flex-col gap-3 px-4 py-4 md:px-6 md:py-5" aria-labelledby="epics-h">
      {/* The page-level title is owned by the App's topbar; this remains the
          section's accessible name for screen readers. */}
      <h2 id="epics-h" className="sr-only">
        Open Epics
      </h2>
      {epics.length === 0 ? (
        <p className="py-12 text-center text-[13px] text-[color:var(--fg-muted)]">
          No open Epics for this repo.
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {epics.map((card) => {
            const variant = card.runner ? chipVariantForState(card.runner.state) : "idle";
            return (
              <li
                key={`${card.repo}#${card.ref}`}
                data-epic={card.ref}
                className={cn(
                  "group rounded-md border border-[color:var(--border)] bg-[color:var(--panel)] px-4 py-3",
                  "transition-colors duration-100 hover:border-[color:var(--border-strong)] hover:bg-[color:var(--panel-hover)]",
                )}
              >
                {/* Head row: epic ref (mono) + title (sans) — left; status chip — right. */}
                <div className="flex items-baseline gap-3">
                  <span className="min-w-0 flex-1 truncate text-[13.5px] leading-tight">
                    <span className="font-mono text-[12px] text-[color:var(--fg-muted)]">
                      <EpicRef epicNumber={card.number} epicRef={card.ref} />
                    </span>{" "}
                    <span className="font-medium text-foreground">{card.title}</span>
                  </span>
                  {card.runner ? (
                    // Wrap the chip in a focusable button only when the
                    // inspector callback is wired. Otherwise an undefined
                    // handler would leave a no-op control in the tab order —
                    // a chip with no behavior is honestly a chip, not a
                    // button. (CodeRabbit #234.)
                    onOpenInspector ? (
                      <button
                        type="button"
                        className="cursor-pointer"
                        onClick={() => onOpenInspector(card.runner!.session)}
                        aria-label={`Open inspector for ${card.runner.session}`}
                      >
                        <StatusChip variant={variant}>
                          {card.runner.adapter} · {card.runner.state}
                        </StatusChip>
                      </button>
                    ) : (
                      <StatusChip variant={variant}>
                        {card.runner.adapter} · {card.runner.state}
                      </StatusChip>
                    )
                  ) : (
                    <StatusChip variant="idle">idle</StatusChip>
                  )}
                </div>

                {/* Progress strip — thin bar, breathing room above and below. */}
                <div className="pt-3">
                  <ProgressStrip closed={card.progress.closed} total={card.progress.total} />
                </div>

                {/* Optional decision callout — muted, lower visual weight. */}
                {card.decision ? (
                  <div className="pt-2 text-[12px] text-[color:var(--fg-muted)]">
                    <span className="font-medium text-foreground">{card.decision.label}</span>
                    <span> — {card.decision.oneLiner}</span>
                    {card.decision.link ? (
                      <>
                        {" "}
                        <a
                          href={card.decision.link}
                          className="font-mono text-[11.5px] text-[color:var(--accent)]"
                        >
                          open
                        </a>
                      </>
                    ) : null}
                  </div>
                ) : null}

                <DispatchControl card={card} adapters={adapters} onDispatch={onDispatch} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
