-- 006_pr_divergence_state.sql
-- Most-recent PR mergeability classification used by the open-PR reconciler
-- (Epic #168). One row per managed PR; the reconciler upserts on every pass so
-- the row is the freshest observation, not a history (an audit log is out of
-- scope — observability reads `events` for trends).
--
-- `state` covers the four classifier outputs (CLEAN/BEHIND/CONFLICTED/UNKNOWN)
-- plus two terminal-ish outcomes the reconciler writes itself (DEMOTED when the
-- escalation path fires, SKIPPED when rate-limited). The CHECK pins the
-- vocabulary so a typo in the reconciler surfaces as a constraint violation, not
-- a silently-bad row the auto-dispatch loop later believes.
--
-- Keyed on (repo, pr_number) so the same column works for a future multi-repo
-- daemon — a PR number isn't unique across repos. Today the daemon writes one
-- repo's PRs to this table, but the constraint is correct for tomorrow's case.

CREATE TABLE pr_divergence_state (
  repo           TEXT    NOT NULL,            -- 'owner/name'
  pr_number      INTEGER NOT NULL,
  state          TEXT    NOT NULL CHECK (state IN (
    'CLEAN', 'BEHIND', 'CONFLICTED', 'UNKNOWN', 'DEMOTED', 'SKIPPED'
  )),
  classified_at  INTEGER NOT NULL,             -- epoch ms of the latest write
  PRIMARY KEY (repo, pr_number)
);

CREATE INDEX idx_pr_divergence_state ON pr_divergence_state(state);
