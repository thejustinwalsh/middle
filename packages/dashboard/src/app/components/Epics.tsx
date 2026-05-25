/**
 * The Epic browse view — the dashboard's primary surface. Lists a repo's open
 * Epics with sub-issue progress, the agent working each (if any), a high-value
 * decision callout from the state issue, and a force-dispatch control whose
 * adapter picker defaults to the recommender's choice. The repo filter lives in
 * {@link App}; this component renders the chosen repo's cards.
 */
import { useState } from "react";
import type { EpicCard } from "../../wire.ts";

function ProgressBar({ closed, total }: { closed: number; total: number }) {
  const pct = total > 0 ? Math.round((closed / total) * 100) : 0;
  return (
    <div className="epic-progress" aria-label={`${closed} of ${total} sub-issues done`}>
      <div className="epic-progress-fill" style={{ width: `${pct}%` }} />
      <span className="epic-progress-label">
        {closed} / {total}
      </span>
    </div>
  );
}

function DispatchControl({
  card,
  adapters,
  onDispatch,
}: {
  card: EpicCard;
  adapters: string[];
  onDispatch: (repo: string, epicNumber: number, adapter: string) => void;
}) {
  const [adapter, setAdapter] = useState(card.dispatch.recommendedAdapter ?? adapters[0] ?? "claude");
  // An adapter absent from freeSlots has unknown availability — treat as no slot
  // (it isn't a configured/dispatchable adapter, so the server would reject it anyway).
  const slot = card.dispatch.freeSlots.find((s) => s.adapter === adapter);
  const noSlot = slot ? !slot.available : true;
  const disabled = card.dispatch.inFlight || noSlot;
  return (
    <div className="epic-dispatch">
      <select
        aria-label="agent"
        value={adapter}
        onChange={(e) => setAdapter(e.target.value)}
        disabled={card.dispatch.inFlight}
      >
        {adapters.map((a) => (
          <option key={a} value={a}>
            {a}
            {a === card.dispatch.recommendedAdapter ? " ★" : ""}
          </option>
        ))}
      </select>
      <button
        type="button"
        aria-label={`Dispatch Epic #${card.number}`}
        disabled={disabled}
        title={card.dispatch.inFlight ? "already in flight" : noSlot ? "no free slot" : ""}
        onClick={() => onDispatch(card.repo, card.number, adapter)}
      >
        dispatch
      </button>
    </div>
  );
}

export function Epics({
  epics,
  adapters,
  onDispatch,
  onOpenInspector,
}: {
  epics: EpicCard[];
  adapters: string[];
  onDispatch: (repo: string, epicNumber: number, adapter: string) => void;
  onOpenInspector?: (session: string) => void;
}) {
  return (
    <section className="epics" aria-labelledby="epics-h">
      <h2 id="epics-h">EPICS</h2>
      {epics.length === 0 ? (
        <p className="empty">No open Epics for this repo.</p>
      ) : (
        <ul>
          {epics.map((card) => (
            <li key={card.number} className="epic-card" data-epic={card.number}>
              <div className="epic-head">
                <span className="epic-title">
                  #{card.number} {card.title}
                </span>
                {card.runner ? (
                  <button
                    type="button"
                    className="epic-agent"
                    onClick={() => onOpenInspector?.(card.runner!.session)}
                  >
                    {card.runner.adapter} · {card.runner.state}
                  </button>
                ) : (
                  <span className="epic-agent idle">idle</span>
                )}
              </div>
              <ProgressBar closed={card.progress.closed} total={card.progress.total} />
              {card.decision ? (
                <div className="epic-decision">
                  <span className="label">{card.decision.label}</span> — {card.decision.oneLiner}
                  {card.decision.link ? (
                    <>
                      {" "}
                      <a href={card.decision.link}>open</a>
                    </>
                  ) : null}
                </div>
              ) : null}
              <DispatchControl card={card} adapters={adapters} onDispatch={onDispatch} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
