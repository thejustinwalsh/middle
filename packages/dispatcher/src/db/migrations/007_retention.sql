-- 007_retention.sql
-- Retention bookkeeping. A daily cron deletes `events` older than 14 days and
-- archives `completed` workflows older than 30 days: their events are dropped
-- while the row itself — final state plus the config snapshot in meta_json — is
-- preserved. `archived_at` both marks an archived workflow (so the pass is
-- idempotent) and lets `mm doctor` distinguish live from archived rows.
-- `retention_runs` records every pass so `mm doctor` can report recent status.
-- Retention is SQLite-only — GitHub is the system of record and is never touched.

ALTER TABLE workflows ADD COLUMN archived_at INTEGER; -- epoch ms when archived; null = live

CREATE INDEX idx_workflows_archived ON workflows(archived_at);

CREATE TABLE retention_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at             INTEGER NOT NULL,             -- epoch ms when the pass ran
  events_deleted     INTEGER NOT NULL,             -- event rows pruned (older than 14d)
  workflows_archived INTEGER NOT NULL,             -- completed workflows archived (older than 30d)
  ok                 INTEGER NOT NULL DEFAULT 1,   -- 1 = clean pass, 0 = errored
  detail             TEXT                          -- error message when ok=0, else null
);

CREATE INDEX idx_retention_runs_ran_at ON retention_runs(ran_at);
