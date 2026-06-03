-- 010_epics_ref_key.sql
-- Re-key the Epic browse cache from (repo, number) to (repo, ref) so a file-mode
-- Epic — a slug with no GitHub issue number — is representable in the cache and
-- surfaces in `mm status` / the dashboard (#200). Mirrors migration 009's
-- workflows.epic_ref: `ref` is the canonical identifier (the numeric string in
-- github mode, the slug in file mode); `number` becomes nullable (null for a
-- file Epic). SQLite can't change a PRIMARY KEY in place, so rebuild the table.
--
-- Backfill: every existing (github-mode) row gets ref = CAST(number AS TEXT),
-- byte-identical to how github-mode workflows derive epic_ref.

CREATE TABLE epics_new (
  repo           TEXT    NOT NULL,
  ref            TEXT    NOT NULL,             -- canonical: numeric string | slug
  number         INTEGER,                      -- null for a file-mode Epic
  title          TEXT    NOT NULL,
  state          TEXT    NOT NULL,             -- 'open' | 'closed'
  labels_json    TEXT    NOT NULL DEFAULT '[]',
  sub_total      INTEGER NOT NULL DEFAULT 0,
  sub_closed     INTEGER NOT NULL DEFAULT 0,
  gh_updated_at  TEXT,                         -- reserved (see migration 005)
  last_refreshed INTEGER NOT NULL,
  PRIMARY KEY (repo, ref)
);

INSERT INTO epics_new
  (repo, ref, number, title, state, labels_json, sub_total, sub_closed, gh_updated_at, last_refreshed)
  SELECT repo, CAST(number AS TEXT), number, title, state, labels_json,
         sub_total, sub_closed, gh_updated_at, last_refreshed
    FROM epics;

DROP TABLE epics;
ALTER TABLE epics_new RENAME TO epics;
