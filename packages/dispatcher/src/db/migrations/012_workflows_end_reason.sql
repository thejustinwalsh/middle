-- 012_workflows_end_reason.sql
-- Surface the specific run-end reason for non-normal terminations so the
-- dashboard Activity view can render actionable labels (e.g. "session ended
-- before Stop hook" vs "Stop hook timed out") instead of only the bare state.
-- NULL means a normal terminal state (completed / cancelled) or a failed/
-- compensated row where no specific reason was recorded.
ALTER TABLE workflows ADD COLUMN end_reason TEXT;
