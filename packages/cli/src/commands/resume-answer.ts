import { loadConfig } from "@middle/core";
import { deriveRepoSlug } from "../paths.ts";

export type ResumeAnswerOptions = {
  /** Override the global config path (defaults to `~/.middle/config.toml`). */
  configPath?: string;
  /** Injectable repo-slug resolver (defaults to the git-remote derivation). */
  resolveSlug?: (repoPath: string) => Promise<string>;
};

/**
 * `mm resume <repo> <epic> --answer "<text>"` — manually unblock a parked Epic by
 * POSTing the answer to the daemon's `/control/resume`. The daemon looks up the
 * `waiting-human` workflow by `(repo, epicRef)` and fires its resume signal with
 * the answer text. Works in both modes (the lookup is by `epic_ref`, a slug or a
 * stringified number). The Phase-1 escape hatch before the file-watcher lands.
 *
 * Returns a process exit code: 0 on a resumed workflow, 1 on a bad ref, an
 * unreachable daemon, or a 404 (no parked workflow owns the ref).
 */
export async function runResumeAnswer(
  repoPath: string,
  epicArg: string,
  answer: string,
  opts: ResumeAnswerOptions = {},
): Promise<number> {
  const epicRef = epicArg.trim();
  if (epicRef === "") {
    console.error("mm resume: missing epic (pass the slug or issue number to resume)");
    return 1;
  }
  if (answer.trim() === "") {
    console.error("mm resume: --answer must be a non-empty string");
    return 1;
  }

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig({ globalPath: opts.configPath });
  } catch (error) {
    console.error(`mm resume: failed to load config — ${(error as Error).message}`);
    return 1;
  }

  const repo = await (opts.resolveSlug ?? deriveRepoSlug)(repoPath);
  const base = `http://127.0.0.1:${config.global.dispatcherPort}`;

  try {
    const res = await fetch(`${base}/control/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo, epicRef, answer }),
    });
    if (res.status === 404) {
      console.error(`mm resume: no parked workflow for Epic ${epicRef} in ${repo}`);
      return 1;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`mm resume: rejected (${res.status})${detail ? ` — ${detail}` : ""}`);
      return 1;
    }
    const body = (await res.json().catch(() => null)) as { workflowId?: unknown } | null;
    const workflowId = typeof body?.workflowId === "string" ? body.workflowId : "(unknown)";
    console.log(`mm resume: ${repo} epic ${epicRef} → resumed workflow ${workflowId}`);
    return 0;
  } catch (error) {
    console.error(`mm resume: could not reach dispatcher on ${base} — ${(error as Error).message}`);
    return 1;
  }
}
