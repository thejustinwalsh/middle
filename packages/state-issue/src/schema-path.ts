import { join } from "node:path";

/**
 * Absolute path to the canonical state-issue schema (`schemas/state-issue.v1.md`)
 * — resolved from the **middle installation**, never from a target repo.
 *
 * The recommender points its agent at this file so the agent can read the v1
 * state-issue format. The schema is the single source of truth (see the root
 * CLAUDE.md "state-issue contract"); it is *not* stamped into bootstrapped repos,
 * so callers must resolve it here rather than at `<repoPath>/schemas/…` — which
 * exists only in middle's own checkout.
 *
 * Resolved from this module's own location (`import.meta.dir`), so it is stable
 * regardless of the caller's cwd or which target repo is in play — the same
 * source-tree asset-resolution pattern as `packages/cli/src/bootstrap/skills-sync.ts`
 * (its `..` count differs because it sits one directory deeper). This file lives
 * at `packages/state-issue/src/`, so the repo root is three levels up.
 */
export const STATE_ISSUE_SCHEMA_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "schemas",
  "state-issue.v1.md",
);
