import type { BuildPromptOpts } from "@middle/core";

/**
 * The literal text `send-keys` carries into a Copilot tmux session to start or
 * continue the agent. Mirrors the Claude/Codex contract — the dispatch model (a
 * single one-line submission that both invokes the implementing skill and
 * `@`-references the on-disk brief) is adapter-agnostic, and the skills are
 * mirrored into Copilot's skill surface at bootstrap so the same slash-command
 * invocation resolves.
 *
 * - `initial`: a slash command that force-invokes the implementing skill on the
 *   Epic; the skill reads `.middle/prompt.md` itself (a single submission both
 *   starts the skill and delivers the brief — the launch→drive step drives one
 *   turn).
 * - `resume` / `answer`: an `@`-reference that force-includes the on-disk brief.
 * - `recommender` / `docs`: force-invokes the repo-level skill with the assembled
 *   context `@`-referenced.
 *
 * NOTE (tightening point, mirrors Codex's prompt.ts): Copilot's exact custom-skill
 * invocation + force-include syntax (`/<skill>` slash form vs. the `skill` tool,
 * and where skills are mirrored under `.copilot/`) is verified on a live run — see
 * `planning/issues/124/decisions.md`. The `@`-path reference and slash-command form
 * are the cross-adapter parity baseline; #126 refines the Copilot framing.
 */
export function buildPromptText(opts: BuildPromptOpts): string {
  switch (opts.kind) {
    case "initial":
      return `/implementing-github-issues implement #${opts.epicRef}`;
    case "resume":
      return `Resuming this workstream — re-read the linked context and continue. @${opts.promptFile}`;
    case "answer":
      return `A human answered your open question — read the answer and continue. @${opts.promptFile}`;
    case "recommender":
      return `/recommending-github-issues @${opts.promptFile}`;
    case "docs":
      return `/documenting-the-repo @${opts.promptFile}`;
  }
}
