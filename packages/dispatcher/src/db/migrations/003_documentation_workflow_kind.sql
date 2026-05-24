-- 003_documentation_workflow_kind.sql
-- Widen the workflows.kind CHECK to admit 'documentation' — the docs-harvester
-- bot's workflow kind, the recommender's sibling.
--
-- SQLite can't alter a CHECK in place, so rebuild the table with the standard
-- create-new → copy → drop-old → rename recipe. The migration runner disables
-- foreign-key enforcement around the loop (see runMigrations), so dropping the
-- old `workflows` does NOT cascade-delete child rows (events, waitfor_signals)
-- and the transient missing-table window between DROP and RENAME is tolerated.
-- Dropping (not renaming) the original leaves children referencing "workflows"
-- by name, so the rebuilt table re-satisfies their FKs. The runner's
-- foreign_key_check verifies that before committing.

CREATE TABLE workflows_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('implementation', 'recommender', 'documentation')),
  repo TEXT NOT NULL,           -- 'owner/name'
  epic_number INTEGER,          -- the dispatched Epic or standalone issue; null for recommender/documentation
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

INSERT INTO workflows_new SELECT * FROM workflows;

DROP TABLE workflows;

ALTER TABLE workflows_new RENAME TO workflows;

CREATE INDEX idx_workflows_state ON workflows(state);
CREATE INDEX idx_workflows_repo ON workflows(repo);
CREATE INDEX idx_workflows_heartbeat ON workflows(last_heartbeat);
