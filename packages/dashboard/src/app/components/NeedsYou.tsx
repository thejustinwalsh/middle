import type { NeedsYouItem } from "../../wire.ts";
import { Button } from "./ui/button.tsx";

/**
 * The "Needs You" panel — the dashboard's primary surface. Renders the `items`
 * (the server folds `needsHumanInput` across every repo plus ready-for-review
 * Epic PRs into `/api/needs-you`); an empty list shows the "system is working"
 * placeholder. `onOpen`, if given, is invoked with the clicked item.
 */
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
              <Button
                variant="link"
                className="needs-you-open h-auto justify-start p-0 text-foreground"
                onClick={() => onOpen?.(item)}
              >
                ↑ {item.repo} #{item.issue} — <span className="label">{item.label}</span>
              </Button>
              <div className="one-liner">{item.oneLiner}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
