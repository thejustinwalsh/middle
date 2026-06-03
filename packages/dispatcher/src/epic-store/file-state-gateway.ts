/**
 * `fileStateGateway` — the file-backed `StateGateway`. The recommender's state
 * lives in a local Markdown file (`state_file`, e.g. `.middle/state.md`) instead
 * of a GitHub issue. `readBody`/`writeBody` are atomic against that one file; the
 * `issueNumber` arg is part of the shared interface but unused in file mode (the
 * path comes from config, not an issue id).
 *
 * The `applyDispatcherSections` / `renderStateIssue` flow in `state-issue.ts` is
 * unchanged — same parser, same byte-identical round-trip — so the dispatcher
 * writes the In-flight section directly, closing #180's out-of-band-rewrite class
 * for file mode.
 */

import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { StateGateway } from "../state-issue.ts";

export type FileStateGatewayDeps = {
  /** Absolute path to this repo's recommender state file (e.g. `.middle/state.md`). */
  stateFile: string;
};

export function makeFileStateGateway(deps: FileStateGatewayDeps): StateGateway {
  const { stateFile } = deps;
  return {
    async readBody(_repo, _issueNumber): Promise<string> {
      if (!existsSync(stateFile)) {
        throw new Error(`state file not found: ${stateFile} (run \`mm init\` for this repo)`);
      }
      return readFileSync(stateFile, "utf8");
    },

    async writeBody(_repo, _issueNumber, body): Promise<void> {
      // Atomic write: temp sibling + rename, so a concurrent reader never sees a
      // half-written state file. The temp is cleaned up on a write failure.
      mkdirSync(dirname(stateFile), { recursive: true });
      const tmp = join(dirname(stateFile), `.${pathStem(stateFile)}.tmp`);
      try {
        writeFileSync(tmp, body);
        renameSync(tmp, stateFile);
      } catch (error) {
        rmSync(tmp, { force: true });
        throw error;
      }
    },
  };
}

/** The filename (without directory) of a path — for naming the sibling temp file. */
function pathStem(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
