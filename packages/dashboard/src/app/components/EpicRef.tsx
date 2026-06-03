/**
 * Renders an Epic reference per the dispatch mode the workflow row carries:
 *
 * - **github mode** (`epicNumber !== null`) → plain `#N` text, byte-for-byte
 *   what the surfaces rendered before file mode existed. Deliberately not an
 *   anchor — AC4 of #187 is "no behavior change for github-mode rows".
 * - **file mode** (`epicNumber === null`, `epicRef` a slug) → the slug as a
 *   `file://planning/epics/<slug>.md` link, the on-disk Epic file. No GitHub
 *   link in file mode (the Epic isn't a GitHub issue).
 * - **no Epic** (both null — a recommender / documentation row) → the caller's
 *   `fallback`, defaulting to the em dash the surfaces already showed.
 *
 * The `fallback` prop exists because the two callers differ in their pre-#187
 * empty rendering (the runner surfaces showed `#—`, others a bare `—`); keeping
 * it configurable preserves each surface's exact output.
 */

/**
 * Build the `file://` href for an Epic file from its slug. The slug is a single
 * path segment, URL-encoded so a malformed value can't break out of the
 * `planning/epics/` directory or inject markup into the `href`.
 */
export function epicFileHref(slug: string): string {
  return `file://planning/epics/${encodeURIComponent(slug)}.md`;
}

export function EpicRef({
  epicNumber,
  epicRef,
  fallback = "—",
}: {
  epicNumber: number | null;
  epicRef: string | null;
  /** What to render when there's no Epic at all (both ids null). */
  fallback?: string;
}) {
  if (epicNumber !== null) return <>#{epicNumber}</>;
  // A present *and non-blank* slug is the file-mode signal. A null column is JS
  // null; an empty/whitespace value (no real writer produces one today, but a
  // future one could) would otherwise render an empty-labelled link to
  // `planning/epics/.md`, so treat it as "no Epic" and fall through.
  const slug = epicRef?.trim();
  if (slug) {
    return (
      <a className="epic-file-link" href={epicFileHref(slug)}>
        {slug}
      </a>
    );
  }
  return <>{fallback}</>;
}
