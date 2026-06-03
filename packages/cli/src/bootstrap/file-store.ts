// File-mode Epic-store scaffolding for `mm init --epic-store=file`. Writes the
// local Epic directory + recommender state file + per-repo Epic-store config a
// file-mode repo needs, with ZERO `gh`/GitHub calls. The github-mode path is
// untouched — this module is only reached when `epicStore === "file"`.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { renderStateIssue } from "@middle/state-issue";
import type { ParsedState } from "@middle/state-issue";
import { DEFAULT_EPICS_DIR, DEFAULT_STATE_FILE } from "@middle/dispatcher/src/repo-config.ts";
import type { RepoInfo } from "./types.ts";

/** Default Epic directory + state file a file-mode repo scaffolds (repo-root relative). */
export const FILE_EPICS_DIR = DEFAULT_EPICS_DIR;
export const FILE_STATE_FILE = DEFAULT_STATE_FILE;

/**
 * The repo-slug stem used to name the per-repo Epic-store config file
 * (`.middle/<repo-slug>.toml`). A slug can't be a path segment (`owner/name`
 * contains a `/`), so it's flattened to `owner-name`.
 */
export function repoSlugStem(info: RepoInfo): string {
  return `${info.owner}-${info.name}`;
}

/**
 * Render a minimal, schema-conforming empty recommender state body — the
 * file-mode equivalent of the state issue's initial body. It carries the
 * state-issue v1 marker and round-trips byte-identically through
 * `parseStateIssue`/`renderStateIssue`, so the dispatcher can edit it
 * section-by-section like a GitHub state issue.
 */
export function renderEmptyStateBody(now: Date): string {
  const empty: ParsedState = {
    version: 1,
    generated: now.toISOString(),
    runId: "init",
    intervalMinutes: 30,
    readyToDispatch: [],
    needsHumanInput: [],
    blocked: [],
    inFlight: [],
    excluded: [],
    rateLimits: { claude: "ok", codex: "ok", github: "ok" },
    slotUsage: { adapters: [], total: { used: 0, max: 0 }, global: { used: 0, max: 0 } },
  };
  return renderStateIssue(empty);
}

/**
 * The `planning/epics/README.md` explainer — a one-screen description of
 * file-mode Epics plus a copy-paste Epic-file template. The template is a
 * valid v1 Epic body (parses with `parseEpicFile`), so a human can author a
 * first Epic by copying it.
 */
export function renderEpicsReadme(): string {
  return `# Epics (file mode)

This repo runs middle-management in **file mode**: each Epic is a Markdown file
in this directory instead of a GitHub issue. The recommender ranks the open
Epics here; \`mm dispatch\` runs an agent against one.

- One file per Epic: \`<slug>.md\` (the filename stem is the Epic's \`slug\`).
- The recommender's dispatch state lives in \`${FILE_STATE_FILE}\` (not a GitHub issue).
- Markers (\`<!-- middle:… -->\`) are the structural contract — write your prose
  *between* markers; the dispatcher owns the marker attribute lines.

## Epic file template

Copy this into \`<slug>.md\` and fill it in:

\`\`\`md
<!-- middle:epic v1 -->
# Short Epic title

<!-- middle:meta
slug: my-epic-slug
approved: true
-->

## Context

Why this Epic exists and what "done" looks like.

## Acceptance criteria

- [ ] First observable, testable outcome
- [ ] Second observable, testable outcome

## Sub-issues

<!-- middle:sub-issue id=1 -->
- [ ] **1 — First phase**
  What this phase delivers.
<!-- /middle:sub-issue -->

<!-- middle:conversation -->
<!-- /middle:conversation -->
\`\`\`
`;
}

export type FileStoreScaffoldOptions = {
  /** Absolute path to the target repo checkout. */
  repo: string;
  /** Resolved repo identity (used to name the per-repo config file). */
  info: RepoInfo;
  /** Clock seam for the state body's `generated` timestamp. */
  now: Date;
};

/** Absolute paths of the four files the file-mode scaffold writes. */
export type FileStorePaths = {
  epicsReadme: string;
  epicsKeep: string;
  stateFile: string;
  configToml: string;
};

/** The absolute paths the file-mode scaffold targets for a given repo. */
export function fileStorePaths(repo: string, info: RepoInfo): FileStorePaths {
  return {
    epicsReadme: join(repo, FILE_EPICS_DIR, "README.md"),
    epicsKeep: join(repo, FILE_EPICS_DIR, ".keep"),
    stateFile: join(repo, FILE_STATE_FILE),
    configToml: join(repo, ".middle", `${repoSlugStem(info)}.toml`),
  };
}

/** The `[epic_store]` config block for a file-mode repo. */
export function renderEpicStoreToml(): string {
  return `[epic_store]
mode = "file"
epics_dir = "${FILE_EPICS_DIR}"
state_file = "${FILE_STATE_FILE}"
`;
}

/**
 * Write the file-mode scaffold: `planning/epics/README.md` + `.keep`, the empty
 * recommender state file, and the per-repo `[epic_store]` config TOML. Pure
 * filesystem work — never touches `gh`/GitHub. Returns the paths written.
 */
export async function writeFileStoreScaffold(
  opts: FileStoreScaffoldOptions,
): Promise<FileStorePaths> {
  const paths = fileStorePaths(opts.repo, opts.info);
  await mkdir(join(opts.repo, FILE_EPICS_DIR), { recursive: true });
  await mkdir(join(opts.repo, ".middle"), { recursive: true });
  await Promise.all([
    Bun.write(paths.epicsReadme, renderEpicsReadme()),
    Bun.write(paths.epicsKeep, ""),
    Bun.write(paths.stateFile, renderEmptyStateBody(opts.now)),
    Bun.write(paths.configToml, renderEpicStoreToml()),
  ]);
  return paths;
}
