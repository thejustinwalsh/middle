-- 002_waitfor_fired.sql
-- The GitHub poller (Phase 5) fires a workflow's resume signal once per park.
-- `fired_at` records when a signal was fired so a subsequent poll pass does not
-- re-fire the same wait before the workflow has resumed and consumed the row.
-- A fresh park (next review round) deletes-and-reinserts the row, clearing it.

ALTER TABLE waitfor_signals ADD COLUMN fired_at INTEGER;

INSERT OR IGNORE INTO schema_version VALUES (2);
