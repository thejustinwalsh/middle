/**
 * The Epic browse cache (table `epics`, migrations 005 + 010). `refreshEpics`
 * pulls a repo's open Epics from its mode's gateway (github or file, via the
 * routing gateway) and upserts them, keyed on the canonical `ref` (numeric string
 * in github mode, slug in file mode); Epics no longer in the open set are marked
 * `closed` (kept, not deleted, so a just-closed Epic doesn't flicker out
 * mid-view). `readEpics` returns the open rows the dashboard browses. Ref-keying
 * (010) is what lets a file-mode Epic — which has no GitHub number — be cached
 * and surface in `mm status` / the dashboard (#200).
 */
import type { Database } from "bun:sqlite";
import type { EpicGateway } from "./github.ts";

/** A cached Epic row, projected for the dashboard join. */
export type EpicRow = {
  repo: string;
  /** Canonical Epic reference: the numeric string (github) or the slug (file). */
  ref: string;
  /** GitHub issue number, or null for a file-mode Epic (which has only a slug). */
  number: number | null;
  title: string;
  state: string;
  labels: string[];
  subTotal: number;
  subClosed: number;
  lastRefreshed: number;
};

/**
 * Refresh a repo's Epic cache from its mode's Epic gateway. One paginated list
 * call; repo-scoped. Pass the routing Epic gateway so file-mode repos list their
 * Epic files and github-mode repos list issues — both yield the canonical
 * `EpicListItem` (`ref` + nullable `number`) the cache keys on.
 */
export async function refreshEpics(db: Database, repo: string, github: EpicGateway): Promise<void> {
  const epics = await github.listOpenEpics(repo);
  const now = Date.now();
  const upsert = db.query(
    `INSERT INTO epics (repo, ref, number, title, state, labels_json, sub_total, sub_closed, last_refreshed)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)
     ON CONFLICT(repo, ref) DO UPDATE SET
       number = excluded.number, title = excluded.title, state = 'open',
       labels_json = excluded.labels_json, sub_total = excluded.sub_total,
       sub_closed = excluded.sub_closed, last_refreshed = excluded.last_refreshed`,
  );
  const close = db.query(
    `UPDATE epics SET state = 'closed', last_refreshed = ? WHERE repo = ? AND ref = ?`,
  );
  const open = new Set<string>();
  const tx = db.transaction(() => {
    for (const e of epics) {
      upsert.run(
        repo,
        e.ref,
        e.number,
        e.title,
        JSON.stringify(e.labels),
        e.subTotal,
        e.subClosed,
        now,
      );
      open.add(e.ref);
    }
    // Mark cached-but-no-longer-open Epics closed (kept for non-flicker).
    const stale = db.query(`SELECT ref FROM epics WHERE repo = ? AND state = 'open'`).all(repo) as {
      ref: string;
    }[];
    for (const row of stale) {
      if (!open.has(row.ref)) close.run(now, repo, row.ref);
    }
  });
  tx();
}

/** Safe JSON parse for `labels_json` — returns an empty array on malformed input. */
function safeLabels(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * The repo's open Epics. github-mode Epics come first, newest (highest number)
 * first; file-mode Epics (null number) sort after — SQLite orders NULLs last
 * under `DESC` — by ref so the ordering is stable.
 */
export function readEpics(db: Database, repo: string): EpicRow[] {
  const rows = db
    .query(
      `SELECT repo, ref, number, title, state, labels_json AS labelsJson,
              sub_total AS subTotal, sub_closed AS subClosed, last_refreshed AS lastRefreshed
       FROM epics WHERE repo = ? AND state = 'open' ORDER BY number DESC, ref ASC`,
    )
    .all(repo) as (Omit<EpicRow, "labels"> & { labelsJson: string })[];
  return rows.map((r) => ({
    repo: r.repo,
    ref: r.ref,
    number: r.number,
    title: r.title,
    state: r.state,
    labels: safeLabels(r.labelsJson),
    subTotal: r.subTotal,
    subClosed: r.subClosed,
    lastRefreshed: r.lastRefreshed,
  }));
}
