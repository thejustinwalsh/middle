/**
 * The literal text `send-keys` carries into a tmux session to start or continue
 * the agent.
 *
 * - `initial`: a slash command that force-invokes the implementing skill on the
 *   Epic. The skill reads `.middle/prompt.md` (the dispatch brief) itself, so a
 *   single one-line submission both starts the skill and delivers the brief —
 *   which matters because the Phase 1 workflow only drives one turn.
 * - `resume` / `answer`: an `@`-reference that force-includes the on-disk brief
 *   (multi-line context the agent reloads). Used by the fuller multi-turn
 *   workflow; `send-keys` can't carry multi-line text, hence the file pointer.
 * - `recommender`: force-invokes the recommender skill with the assembled
 *   dispatcher context (`.middle/prompt.md`) `@`-referenced, same file-pointer
 *   reason — the context is multi-line so it can't ride the slash command line.
 */
export function buildPromptText(opts: {
  promptFile: string;
  kind: "initial" | "resume" | "answer" | "recommender";
  epicNumber?: number;
}): string {
  switch (opts.kind) {
    case "initial":
      return `/implementing-github-issues implement #${opts.epicNumber}`;
    case "resume":
      return `Resuming this workstream — re-read the linked context and continue. @${opts.promptFile}`;
    case "answer":
      return `A human answered your open question — read the answer and continue. @${opts.promptFile}`;
    case "recommender":
      return `/recommending-github-issues @${opts.promptFile}`;
  }
}
