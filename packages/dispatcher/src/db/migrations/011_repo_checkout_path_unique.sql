-- 011_repo_checkout_path_unique.sql
-- Make the shared-checkout collision guard (#226) atomic at the DB layer.
--
-- `assertNoRepoPathCollision` does a read-check before `registerManagedRepo`
-- writes — fine within one process (bun:sqlite is synchronous), but two
-- *processes* (the daemon + a concurrent `mm init`) can both pass the eager
-- check and then both persist the same `checkout_path`, silently mapping two
-- repo slugs to one checkout. A partial UNIQUE index makes the second write fail
-- at commit time, which `registerManagedRepo` translates back into a
-- `RepoPathCollisionError`.
--
-- Partial (WHERE checkout_path IS NOT NULL) so the many rows that never register
-- a path keep their NULL — SQLite treats each NULL as distinct, but being
-- explicit documents intent and keeps the index small. The eager check stays as
-- the friendly fast path; this index is the correctness backstop.
--
-- De-dupe FIRST. A db written before this index (by an older daemon, or by the
-- very TOCTOU race this closes) can already hold two rows sharing one non-null
-- `checkout_path`; CREATE UNIQUE INDEX over that data would throw and abort the
-- whole migration, bricking startup. Null out the losing duplicates, keeping the
-- lowest-rowid row per path — the same "first writer wins" semantics the runtime
-- guard enforces — so the index build always succeeds. A nulled-out repo simply
-- reads as "not yet managed" and re-registers its path on the next dispatch.
UPDATE repo_config SET checkout_path = NULL
WHERE checkout_path IS NOT NULL
  AND rowid NOT IN (
    SELECT MIN(rowid) FROM repo_config
    WHERE checkout_path IS NOT NULL
    GROUP BY checkout_path
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_config_checkout_path
  ON repo_config (checkout_path)
  WHERE checkout_path IS NOT NULL;
