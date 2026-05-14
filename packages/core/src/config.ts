// Minimal RepoConfig — only the fields Phase 0's state-issue validate() needs.
// The full config.toml shape + loader (global + per-repo TOML merge) lands in
// build-spec Phase 1.
export type RepoConfig = {
  /** Configured adapter names, e.g. ["claude", "codex"]. */
  adapters: string[];
};
