-- 001_initial.sql
-- middle's operational state. SQLite holds operational state only; GitHub is
-- the system of record. Schema source of truth: build spec → "SQLite schema".

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('implementation', 'recommender')),
  repo TEXT NOT NULL,           -- 'owner/name'
  epic_number INTEGER,          -- the dispatched Epic or standalone issue; null for recommender
  adapter TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'launching', 'running', 'waiting-human', 'rate-limited',
    'completed', 'compensated', 'failed', 'cancelled'
  )),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  bunqueue_execution_id TEXT,   -- foreign reference into bunqueue's tables
  worktree_path TEXT,
  session_name TEXT,
  session_token TEXT,
  session_id TEXT,              -- the CLI's own session id, from the SessionStart hook
  transcript_path TEXT,         -- on-disk JSONL transcript; retained after the tmux session ends so --resume stays available
  controlled_by TEXT NOT NULL DEFAULT 'middle' CHECK (controlled_by IN ('middle', 'human')),
  current_sub_issue INTEGER,    -- which sub-issue/phase the agent is on; null for standalone
  pr_number INTEGER,            -- the one PR for this Epic
  pr_branch TEXT,
  last_heartbeat INTEGER,
  meta_json TEXT                -- adapter-specific scratch
);

CREATE INDEX idx_workflows_state ON workflows(state);
CREATE INDEX idx_workflows_repo ON workflows(repo);
CREATE INDEX idx_workflows_heartbeat ON workflows(last_heartbeat);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,           -- normalized event name
  payload_json TEXT,            -- truncated to 16KB
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE INDEX idx_events_workflow_ts ON events(workflow_id, ts);
CREATE INDEX idx_events_ts ON events(ts);    -- for retention scans

CREATE TABLE rate_limit_state (
  adapter TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('AVAILABLE', 'RATE_LIMITED', 'UNKNOWN')),
  reset_at INTEGER,             -- unix ms, null when AVAILABLE/UNKNOWN
  observed_at INTEGER NOT NULL,
  source TEXT,                  -- 'exit', 'stop-hook', 'manual'
  detail TEXT
);

CREATE TABLE repo_config (
  repo TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,    -- snapshot of .middle/config.toml at last sync
  state_issue_number INTEGER,
  last_recommender_run INTEGER,
  paused_until INTEGER,         -- if non-null, no auto-dispatch
  last_synced_at INTEGER NOT NULL
);

CREATE TABLE waitfor_signals (
  signal_name TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  created_at INTEGER NOT NULL,
  payload_json TEXT
);

CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY
);
INSERT INTO schema_version VALUES (1);
