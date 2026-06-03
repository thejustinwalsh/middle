-- 008_workflows_epic_ref.sql
-- The canonical Epic identifier becomes a string ref (`epicRef`) so file-mode
-- workflows can use slugs alongside github-mode workflows' issue numbers.
--
-- - `epic_number` stays as-is (already nullable). github-mode dispatch keeps
--   writing it for back-compat (dashboard links, prior queries).
-- - `epic_ref` is the new authoritative reference. github-mode writes both
--   (`epic_ref = String(epic_number)`); file-mode writes only `epic_ref` (slug).
-- - Backfill: every existing row whose `epic_number` is non-null gets
--   `epic_ref = CAST(epic_number AS TEXT)`. Recommender / documentation
--   workflows have null epic_number and stay null epic_ref (no Epic to
--   reference).
-- - `epic_ref` is nullable at the DB level for the same reason. Application
--   code (`createWorkflowRecord` in `workflow-record.ts`) enforces that every
--   implementation workflow has it populated.

ALTER TABLE workflows ADD COLUMN epic_ref TEXT;
UPDATE workflows SET epic_ref = CAST(epic_number AS TEXT) WHERE epic_number IS NOT NULL;
