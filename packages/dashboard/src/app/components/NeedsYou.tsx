/**
 * The "Needs You" panel — the dashboard's primary surface. Aggregates
 * `needsHumanInput` across every repo plus ready-for-review Epic PRs (the server
 * folds both into `/api/needs-you`). When it's empty, the system is working.
 */
import type { NeedsYouItem } from "../../wire.ts";

export function NeedsYou({
  items,
  onOpen,
}: {
  items: NeedsYouItem[];
  onOpen?: (item: NeedsYouItem) => void;
}) {
  return (
    <section className="needs-you" aria-labelledby="needs-you-h">
      <h2 id="needs-you-h">
        NEEDS YOU <span className="count">{items.length} items</span>
      </h2>
      {items.length === 0 ? (
        <p className="empty">Nothing needs you. The system is working.</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={`${item.repo}#${item.issue}`} className="needs-you-item">
              <button type="button" className="needs-you-open" onClick={() => onOpen?.(item)}>
                ↑ {item.repo} #{item.issue} — <span className="label">{item.label}</span>
              </button>
              <div className="one-liner">{item.oneLiner}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
