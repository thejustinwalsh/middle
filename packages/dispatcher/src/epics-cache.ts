/**
 * The Epic browse cache (table `epics`, migration 005). `refreshEpics` pulls a
 * repo's open Epics from GitHub and upserts them; Epics no longer in the open set
 * are marked `closed` (kept, not deleted, so a just-closed Epic doesn't flicker
 * out mid-view). `readEpics` returns the open rows the dashboard browses.
 */
import type { Database } from "bun:sqlite";
import type { GitHubGateway } from "./github.ts";

/** A cached Epic row, projected for the dashboard join. */
export type EpicRow = {
  repo: string;
  number: number;
  title: string;
  state: string;
  labels: string[];
  subTotal: number;
  subClosed: number;
  lastRefreshed: number;
};

/** Refresh a repo's Epic cache from GitHub. One paginated list call; repo-scoped. */
export async function refreshEpics(
  db: Database,
  repo: string,
  github: GitHubGateway,
): Promise<void> {
  const epics = await github.listOpenEpics(repo);
  const now = Date.now();
  const upsert = db.query(
    `INSERT INTO epics (repo, number, title, state, labels_json, sub_total, sub_closed, last_refreshed)
     VALUES (?, ?, ?, 'open', ?, ?, ?, ?)
     ON CONFLICT(repo, number) DO UPDATE SET
       title = excluded.title, state = 'open', labels_json = excluded.labels_json,
       sub_total = excluded.sub_total, sub_closed = excluded.sub_closed,
       last_refreshed = excluded.last_refreshed`,
  );
  const close = db.query(
    `UPDATE epics SET state = 'closed', last_refreshed = ? WHERE repo = ? AND number = ?`,
  );
  const open = new Set<number>();
  const tx = db.transaction(() => {
    for (const e of epics) {
      upsert.run(repo, e.number, e.title, JSON.stringify(e.labels), e.subTotal, e.subClosed, now);
      open.add(e.number);
    }
    // Mark cached-but-no-longer-open Epics closed (kept for non-flicker).
    const stale = db
      .query(`SELECT number FROM epics WHERE repo = ? AND state = 'open'`)
      .all(repo) as { number: number }[];
    for (const row of stale) {
      if (!open.has(row.number)) close.run(now, repo, row.number);
    }
  });
  tx();
}

/** The repo's open Epics, newest (highest number) first. */
export function readEpics(db: Database, repo: string): EpicRow[] {
  const rows = db
    .query(
      `SELECT repo, number, title, state, labels_json AS labelsJson,
              sub_total AS subTotal, sub_closed AS subClosed, last_refreshed AS lastRefreshed
       FROM epics WHERE repo = ? AND state = 'open' ORDER BY number DESC`,
    )
    .all(repo) as (Omit<EpicRow, "labels"> & { labelsJson: string })[];
  return rows.map((r) => ({
    repo: r.repo,
    number: r.number,
    title: r.title,
    state: r.state,
    labels: JSON.parse(r.labelsJson) as string[],
    subTotal: r.subTotal,
    subClosed: r.subClosed,
    lastRefreshed: r.lastRefreshed,
  }));
}
