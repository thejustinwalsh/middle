-- 005_epics.sql
-- The Epic browse cache. Refreshed from GitHub on an interval and after dispatch;
-- the dashboard's GET /api/epics reads it instead of hitting GitHub per page-view.
-- An Epic that drops out of the open set is marked state='closed' (not deleted)
-- so a just-closed Epic doesn't flicker out of an open view mid-refresh.
CREATE TABLE epics (
  repo           TEXT    NOT NULL,
  number         INTEGER NOT NULL,
  title          TEXT    NOT NULL,
  state          TEXT    NOT NULL,             -- 'open' | 'closed'
  labels_json    TEXT    NOT NULL DEFAULT '[]',
  sub_total      INTEGER NOT NULL DEFAULT 0,
  sub_closed     INTEGER NOT NULL DEFAULT 0,
  gh_updated_at  TEXT,
  last_refreshed INTEGER NOT NULL,             -- epoch ms of our last write
  PRIMARY KEY (repo, number)
);
