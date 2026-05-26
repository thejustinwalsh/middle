import type { BuildPromptOpts } from "@middle/core";

/**
 * The literal text `send-keys` carries into a Codex tmux session to start or
 * continue the agent. Mirrors the Claude adapter's contract — the dispatch model
 * (a single one-line submission that both invokes the skill and `@`-references
 * the on-disk brief) is adapter-agnostic, and the skills are mirrored into
 * `.codex/skills/` at bootstrap so the same slash-command invocation resolves.
 *
 * - `initial`: a slash command that force-invokes the implementing skill on the
 *   Epic; the skill reads `.middle/prompt.md` itself.
 * - `resume` / `answer`: an `@`-reference that force-includes the on-disk brief.
 * - `recommender` / `docs`: force-invokes the repo-level skill with the assembled
 *   context `@`-referenced.
 *
 * NOTE (tightening point): Codex's exact skill-invocation + force-include syntax
 * is verified on a live run (see `planning/issues/60/decisions.md`). The `@`-path
 * reference and slash-command form are the parity baseline.
 */
export function buildPromptText(opts: BuildPromptOpts): string {
  switch (opts.kind) {
    case "initial":
      return `/implementing-github-issues implement #${opts.epicNumber}`;
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
