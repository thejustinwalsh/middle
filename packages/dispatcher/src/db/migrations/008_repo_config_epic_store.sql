-- 007_repo_config_epic_store.sql
-- Per-repo Epic store selection. The default 'github' makes the migration a
-- no-op for every existing row: the dispatcher's bootstrap selector keeps
-- routing to ghGitHub / ghStateIssueGateway / ghPollGateway unchanged. Opting
-- a repo into file mode is a single config edit:
--
--   [epic_store]
--   mode       = "file"
--   epics_dir  = "planning/epics"   -- relative to repo root
--   state_file = ".middle/state.md"
--
-- epics_dir / state_file are nullable — only populated when mode = 'file';
-- in github mode the existing state_issue_number remains the state-source-of-truth.

ALTER TABLE repo_config ADD COLUMN epic_store TEXT NOT NULL DEFAULT 'github';
ALTER TABLE repo_config ADD COLUMN epics_dir TEXT;
ALTER TABLE repo_config ADD COLUMN state_file TEXT;
